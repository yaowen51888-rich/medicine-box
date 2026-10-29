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

// ---------- UI 路由与渲染 ----------

const GROUP_LABELS = { expired: "已过期", expiring: "即将过期", ok: "正常" };
let thumbUrls = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function revokeThumbs() {
  thumbUrls.forEach(u => URL.revokeObjectURL(u));
  thumbUrls = [];
}

function route() {
  const hash = location.hash || "#/";
  const views = { "/": "view-home", "/add": "view-add", "/settings": "view-settings" };
  const detailMatch = hash.match(/^#\/detail\/(\d+)$/);
  const key = detailMatch ? "detail" : (views[hash.slice(1)] ? hash.slice(1) : "/");
  document.querySelectorAll(".view").forEach(v => { v.hidden = v.id !== (key === "detail" ? "view-detail" : views[key]); });
  document.querySelectorAll(".tab").forEach(t => {
    if (t.dataset.nav === key) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  });
  if (key === "/") renderHome();
  if (key === "/add") resetAddForm();
  if (key === "detail") renderDetail(Number(detailMatch[1]));
}

async function renderHome() {
  const remindDays = getCfg().remindDays;
  let meds = [];
  try { meds = (await dbAll()).filter(m => m.status === "active"); }
  catch { document.getElementById("storage-banner").hidden = false; return; }

  const stats = document.getElementById("stats");
  const list = document.getElementById("home-list");
  const empty = document.getElementById("home-empty");
  const groups = { expired: [], expiring: [], ok: [] };
  meds.forEach(m => groups[statusOf(m.expiry, new Date(), remindDays)].push(m));

  stats.innerHTML = `
    <div class="stat"><b>${meds.length}</b><span>在箱</span></div>
    <div class="stat is-red"><b>${groups.expired.length}</b><span>已过期</span></div>
    <div class="stat is-orange"><b>${groups.expiring.length}</b><span>${remindDays} 天内到期</span></div>`;

  empty.hidden = meds.length > 0;
  revokeThumbs();
  list.innerHTML = Object.entries(groups).filter(([, arr]) => arr.length).map(([st, arr]) => `
    <section class="med-group st-${st}">
      <h2><span class="dot"></span>${GROUP_LABELS[st]}<span class="count">${arr.length}</span></h2>
      ${arr.map(m => {
        const n = daysUntil(m.expiry);
        const days = n < 0 ? `已过期 ${-n} 天` : `剩 ${n} 天`;
        const thumb = m.photo
          ? `<img class="med-thumb" src="${thumbUrls[thumbUrls.push(URL.createObjectURL(m.photo)) - 1]}" alt="${escapeHtml(m.name)}">`
          : `<div class="med-thumb-placeholder" aria-hidden="true">💊</div>`;
        return `<button class="med-item" data-id="${m.id}">${thumb}
          <span class="med-info"><span class="med-name">${escapeHtml(m.name)}</span><br>
          <span class="med-expiry">${escapeHtml(m.expiry)}</span></span>
          <span class="med-days">${days}</span></button>`;
      }).join("")}
    </section>`).join("");

  list.querySelectorAll(".med-item").forEach(btn =>
    btn.addEventListener("click", () => { location.hash = "#/detail/" + btn.dataset.id; }));
}

function renderDetail() { /* Task 6 实现 */ }

// ---------- 录入屏 ----------

let pendingPhoto = null;
let previewUrl = null;

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function setFieldError(input, show) {
  input.closest(".field").classList.toggle("is-error", show);
  const err = input.closest(".field").querySelector(".field-error");
  if (err) err.hidden = !show;
}

function resetAddForm() {
  const form = document.getElementById("add-form");
  if (!form) return;
  form.reset();
  pendingPhoto = null;
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  document.getElementById("photo-preview-wrap").hidden = true;
  document.getElementById("photo-input").value = "";
  const status = document.getElementById("recognize-status");
  status.textContent = "";
  status.classList.remove("is-error");
  ["f-name", "f-expiry"].forEach(id => setFieldError(document.getElementById(id), false));
}

async function previewAndRecognize(file) {
  const status = document.getElementById("recognize-status");
  const wrap = document.getElementById("photo-preview-wrap");
  const img = document.getElementById("photo-preview");
  status.classList.remove("is-error");
  try {
    const blob = await compressImage(file);
    pendingPhoto = blob;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob);
    img.src = previewUrl;
    wrap.hidden = false;
    status.textContent = "识别中…";
    const r = await callVisionAPI(await blobToBase64(blob));
    if (r && (r.name || r.expiry)) {
      if (r.name) document.getElementById("f-name").value = r.name;
      if (r.expiry) document.getElementById("f-expiry").value = r.expiry;
      status.textContent = "已识别，请核对后保存";
    } else {
      status.textContent = getCfg().key
        ? "识别失败，请手动填写"
        : "识别失败，请手动填写（可在设置中配置识别服务）";
      status.classList.add("is-error");
    }
  } catch {
    pendingPhoto = null;
    wrap.hidden = true;
    status.textContent = "图片读取失败，请重新拍摄";
    status.classList.add("is-error");
  }
}

function wireAddScreen() {
  document.getElementById("pick-photo").addEventListener("click", () =>
    document.getElementById("photo-input").click());
  document.getElementById("photo-input").addEventListener("change", e => {
    if (e.target.files[0]) previewAndRecognize(e.target.files[0]);
  });
  document.getElementById("add-form").addEventListener("submit", async e => {
    e.preventDefault();
    const name = document.getElementById("f-name");
    const expiry = document.getElementById("f-expiry");
    const nameOk = !!name.value.trim();
    const expiryOk = !!expiry.value;
    setFieldError(name, !nameOk);
    setFieldError(expiry, !expiryOk);
    if (!nameOk || !expiryOk) return;
    await dbAdd({
      name: name.value.trim(),
      expiry: expiry.value,
      note: document.getElementById("f-note").value.trim(),
      photo: pendingPhoto,
    });
    resetAddForm();
    location.hash = "#/";
  });
}

function initApp() {
  if (!document.getElementById("app")) return;
  window.addEventListener("hashchange", route);
  wireAddScreen();
  dbOpen().catch(() => {
    document.getElementById("storage-banner").hidden = false;
    document.getElementById("fab-add").disabled = true;
  });
  route();
}

document.addEventListener("DOMContentLoaded", initApp);
