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
