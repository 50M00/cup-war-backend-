/* ===================================================================
   CUP WAR — منصة منافسة القهوة ضد الشاي
   يشمل: تسجيل دخول/حساب للطلاب، حساب إدارة منفصل،
   واستعادة كلمة المرور عبر رمز تحقق (OTP) يُرسل فعليًا كرسالة SMS.

   رمز التحقق يُرسل عبر خادم خلفي منفصل (مجلد backend/) يستخدم Twilio،
   لأن مفتاح مزود SMS لا يمكن تخزينه بأمان داخل كود يعمل في المتصفح.
   راجع backend/README.md لخطوات النشر الكاملة، ثم عدّل السطر التالي
   ليشير لرابط خادمك بعد نشره:
=================================================================== */
const OTP_API_BASE = "https://github.com/50M00/cup-war-backend-.git"; // ⚠️ استبدل هذا برابط خادم backend/ بعد نشره (راجع backend/README.md)

const BADGE_DEFS = [
  { id: "first", icon: "🥉", label: "أول مشترى", test: s => s.purchases >= 1 },
  { id: "five", icon: "🔥", label: "5 مشتريات", test: s => s.purchases >= 5 },
  { id: "ten", icon: "⚡", label: "10 مشتريات", test: s => s.purchases >= 10 },
  { id: "twentyfive", icon: "👑", label: "25 مشترى", test: s => s.purchases >= 25 },
];

const LEVELS = ["المرحلة الأولى", "المرحلة الثانية", "المرحلة الثالثة", "المرحلة الرابعة", "دراسات عليا"];

const TEAM_META = {
  coffee: { label: "فريق القهوة", emoji: "☕", css: "coffee" },
  tea: { label: "فريق الشاي", emoji: "🍵", css: "tea" },
};

/* ---------- storage helpers ---------- */
async function getKey(key, shared) {
  try {
    const res = await window.storage.get(key, shared);
    return res ? JSON.parse(res.value) : null;
  } catch { return null; }
}
async function setKey(key, value, shared) {
  try { await window.storage.set(key, JSON.stringify(value), shared); return true; }
  catch (e) { console.error("storage error", e); return false; }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ---------- password / otp helpers ---------- */
function genSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(salt + ":" + password);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function makeCredential(password) {
  const salt = genSalt();
  const passwordHash = await hashPassword(password, salt);
  return { salt, passwordHash };
}
async function verifyCredential(password, salt, expectedHash) {
  const h = await hashPassword(password, salt);
  return h === expectedHash;
}
function maskPhone(phone) {
  if (!phone || phone.length < 4) return phone || "";
  return phone.slice(0, 2) + "••••" + phone.slice(-2);
}

/* ---------- app state ---------- */
const state = {
  loading: true,
  students: {},
  teamBonus: { coffee: 0, tea: 0 },
  challenges: [],
  news: [],
  rewards: [],
  settings: { doublePointsActive: false, doubleNote: "" },
  adminAccount: null, // { username, phone, salt, passwordHash }
  purchaseCodes: {},  // code -> { code, points, createdAt, expiresAt, used, usedBy, usedByName }
  session: null,      // { role: 'student'|'admin', id: studentId | 'admin' }
  authView: "landing-student",
  tab: "home",
  adminSection: "purchase",
};
let selectedTeam = null;
let pendingReset = null; // { kind: 'student'|'admin', id, phone, verifyToken }
let pendingClaimCode = new URLSearchParams(window.location.search).get("claim"); // من رابط رمز QR
function stripClaimFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("claim");
  window.history.replaceState({}, "", url);
}

const root = document.getElementById("root");

/* ---------- derived data ---------- */
function computeTeamTotals() {
  const totals = { coffee: state.teamBonus.coffee || 0, tea: state.teamBonus.tea || 0 };
  const purchases = { coffee: 0, tea: 0 };
  const members = { coffee: 0, tea: 0 };
  Object.values(state.students).forEach(s => {
    totals[s.team] = (totals[s.team] || 0) + (s.points || 0);
    purchases[s.team] = (purchases[s.team] || 0) + (s.purchases || 0);
    members[s.team] = (members[s.team] || 0) + 1;
  });
  return { totals, purchases, members };
}
function computeRanking() { return Object.values(state.students).sort((a, b) => b.points - a.points); }
function me() { return state.session && state.session.role === "student" ? state.students[state.session.id] : null; }
function myRank() {
  const m = me();
  if (!m) return null;
  return computeRanking().findIndex(s => s.studentId === m.studentId) + 1;
}

/* ---------- toast ---------- */
function toast(msg, kind) {
  const el = document.createElement("div");
  el.className = "cw-toast" + (kind === "demo" ? " demo" : "");
  el.innerHTML = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), kind === "demo" ? 6000 : 2200);
}

/* ---------- init ---------- */
async function init() {
  const [s, tb, c, n, r, st, admin, pc, session] = await Promise.all([
    getKey("students", true),
    getKey("teamBonus", true),
    getKey("challenges", true),
    getKey("news", true),
    getKey("rewards", true),
    getKey("settings", true),
    getKey("admin_account", true),
    getKey("purchaseCodes", true),
    getKey("session_pointer", false),
  ]);
  if (s) state.students = s;
  if (tb) state.teamBonus = tb;
  if (c) state.challenges = c;
  if (n) state.news = n;
  if (r) state.rewards = r;
  if (st) state.settings = st;
  if (admin) state.adminAccount = admin;
  if (pc) state.purchaseCodes = pc;
  if (session) {
    if (session.role === "student" && state.students[session.id]) state.session = session;
    else if (session.role === "admin" && state.adminAccount) state.session = session;
  }
  state.loading = false;
  if (pendingClaimCode && state.session?.role === "student") state.tab = "claim";
  renderRoot();
}

/* ---------- persistence wrappers ---------- */
async function persistStudents() { await setKey("students", state.students, true); }
async function persistTeamBonus() { await setKey("teamBonus", state.teamBonus, true); }
async function persistChallenges() { await setKey("challenges", state.challenges, true); }
async function persistNews() { await setKey("news", state.news, true); }
async function persistRewards() { await setKey("rewards", state.rewards, true); }
async function persistSettings() { await setKey("settings", state.settings, true); }
async function persistAdmin() { await setKey("admin_account", state.adminAccount, true); }
async function persistSession() { await setKey("session_pointer", state.session, false); }
async function persistPurchaseCodes() { await setKey("purchaseCodes", state.purchaseCodes, true); }

/* =========================================================
   PURCHASE CODES — QR-based point claiming
   الإدارة تولّد رمز شراء بعد عملية بيع حقيقية، والطالب يمسحه
   بكاميرا هاتفه العادية (أو يدخله يدويًا) فتُسجَّل النقطة لحسابه
   تلقائيًا. الرمز يُستخدم مرة واحدة فقط وله صلاحية 15 دقيقة.
========================================================= */
const PURCHASE_CODE_TTL_MS = 15 * 60 * 1000;
function genPurchaseCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // بدون أحرف/أرقام متشابهة (0/O, 1/I/L)
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
async function createPurchaseCode() {
  const code = genPurchaseCode();
  const points = state.settings.doublePointsActive ? 2 : 1;
  const record = { code, points, createdAt: Date.now(), expiresAt: Date.now() + PURCHASE_CODE_TTL_MS, used: false, usedBy: null, usedByName: null };
  state.purchaseCodes[code] = record;
  await persistPurchaseCodes();
  return record;
}
function buildClaimUrl(code) {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("claim", code);
  return url.toString();
}
async function claimPurchaseCode(code, studentId) {
  const fresh = await getKey("purchaseCodes", true); // إعادة قراءة أحدث نسخة لتفادي رمز استُخدم من جهاز آخر بالتوازي
  if (fresh) state.purchaseCodes = fresh;
  const record = state.purchaseCodes[code];
  if (!record) return { ok: false, reason: "رمز غير صالح" };
  if (record.used) return { ok: false, reason: "هذا الرمز مستخدم مسبقًا" };
  if (Date.now() > record.expiresAt) return { ok: false, reason: "انتهت صلاحية الرمز — اطلب رمزًا جديدًا من الإدارة" };

  const s = state.students[studentId];
  if (!s) return { ok: false, reason: "الحساب غير موجود" };

  record.used = true; record.usedBy = studentId; record.usedByName = s.name; record.usedAt = Date.now();
  s.points += record.points; s.purchases += 1;
  await Promise.all([persistPurchaseCodes(), persistStudents()]);
  return { ok: true, points: record.points };
}

/* =========================================================
   TOP-LEVEL RENDER
========================================================= */
function renderRoot() {
  if (state.loading) {
    root.innerHTML = `<div class="cw-loading">جارِ التحميل...</div>`;
    return;
  }
  if (!state.session) { renderAuth(); return; }
  if (state.session.role === "admin") { renderAdminApp(); return; }
  renderStudentApp();
}

/* =========================================================
   AUTH — landing / login / signup / forgot password
========================================================= */

// 🔐 رمز دخول الإدارة لم يعد موجودًا هنا — التحقق منه يصير الآن
// عبر الخادم الخلفي (backend/server.js → /api/admin/verify-gate)
// حتى لا يكون الرمز مكشوفًا لأي شخص يفتح "عرض المصدر" بالمتصفح.
// اضبط الرمز الفعلي في backend/.env تحت ADMIN_ACCESS_CODE.

let adminGateUnlocked = false; // متغيّر جلسة فقط — يُعاد ضبطه عند تحديث الصفحة
const ADMIN_ROUTES = ["landing-admin", "admin-setup", "admin-forgot-1", "admin-forgot-2", "admin-forgot-3"];

function renderAuth() {
  const view = state.authView;
  if (ADMIN_ROUTES.includes(view) && !adminGateUnlocked) {
    return renderAdminGate(view);
  }
  if (view === "student-signup") return renderStudentSignup();
  if (view === "student-forgot-1") return renderStudentForgot1();
  if (view === "student-forgot-2") return renderForgot2("student");
  if (view === "student-forgot-3") return renderForgot3("student");
  if (view === "admin-setup") return renderAdminSetup();
  if (view === "admin-forgot-1") return renderAdminForgot1();
  if (view === "admin-forgot-2") return renderForgot2("admin");
  if (view === "admin-forgot-3") return renderForgot3("admin");
  if (view === "landing-admin") return renderAdminLogin();
  return renderStudentLogin();
}

/* --- admin access gate: a shared secret code required before reaching admin login/setup --- */
function renderAdminGate(nextView) {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🔐 دخول مقيّد</h2>
      <div class="cw-card">
        <p class="cw-hint">هذا القسم خاص بالإدارة فقط. أدخل رمز الوصول اللي أعطتك إياه إدارة المنافسة.</p>
        <input class="cw-input cw-gate-input" id="gate-code" placeholder="رمز الوصول" autocomplete="off">
        <div class="cw-error" id="gate-error"></div>
        <button class="cw-btn-primary" id="gate-submit">متابعة</button>
        <button class="cw-btn-ghost" id="gate-back">رجوع لحساب الطالب</button>
      </div>
    </div>
  `;
  document.getElementById("gate-back").addEventListener("click", () => { state.authView = "landing-student"; renderAuth(); });
  const submit = async () => {
    const entered = document.getElementById("gate-code").value.trim();
    const errEl = document.getElementById("gate-error");
    const btn = document.getElementById("gate-submit");
    if (!entered) { errEl.textContent = "أدخل رمز الوصول"; return; }
    if (!OTP_API_BASE || OTP_API_BASE.includes("YOUR-BACKEND-URL")) {
      errEl.textContent = "لم يتم ربط الخادم الخلفي بعد — راجع backend/README.md";
      return;
    }
    errEl.textContent = "";
    btn.disabled = true; btn.textContent = "جارِ التحقق...";
    try {
      const res = await fetch(`${OTP_API_BASE}/api/admin/verify-gate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: entered }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || "رمز الوصول غير صحيح"; return; }
      adminGateUnlocked = true;
      state.authView = nextView;
      renderAuth();
    } catch (e) {
      errEl.textContent = "تعذر الاتصال بالخادم — تحقق من الإنترنت";
    } finally {
      btn.disabled = false; btn.textContent = "متابعة";
    }
  };
  document.getElementById("gate-submit").addEventListener("click", submit);
  document.getElementById("gate-code").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

function authHero() {
  return `
    <div class="cw-hero">
      <img class="cw-hero-logo" src="assets/logo-icon.png" alt="BREZZO">
      <h1 class="cw-title">CUP WAR</h1>
      <p class="cw-subtitle">من إنتاج BREZZO ☕ القهوة ضد الشاي 🍵 — من يتصدر؟</p>
    </div>
  `;
}
function authFooterLinks() {
  return `
    <button class="cw-auth-switch" id="go-admin">🔒 دخول الإدارة</button>
    <a class="cw-about-link" href="cup-war-pitch.html" target="_blank" rel="noopener">ℹ️ شنو هذا المشروع؟ شوف العرض التقديمي</a>
  `;
}

/* --- student login --- */
function renderStudentLogin() {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-segment">
      <button class="cw-segment-btn active" data-seg="login">تسجيل الدخول</button>
      <button class="cw-segment-btn" data-seg="signup">حساب جديد</button>
    </div>
    <form class="cw-form" id="login-form">
      <label class="cw-label">الرقم الجامعي</label>
      <input class="cw-input" id="li-id" placeholder="Student ID">
      <label class="cw-label">كلمة المرور</label>
      <input class="cw-input" type="password" id="li-pwd" placeholder="••••••••">
      <div class="cw-error" id="li-error"></div>
      <button type="submit" class="cw-btn-primary">دخول 🚀</button>
      <button type="button" class="cw-link-btn" id="li-forgot">نسيت كلمة المرور؟</button>
    </form>
    ${authFooterLinks()}
  `;
  document.querySelector('[data-seg="signup"]').addEventListener("click", () => { state.authView = "student-signup"; renderAuth(); });
  document.getElementById("go-admin").addEventListener("click", () => { state.authView = "landing-admin"; renderAuth(); });
  document.getElementById("li-forgot").addEventListener("click", () => { state.authView = "student-forgot-1"; renderAuth(); });
  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("li-id").value.trim();
    const pwd = document.getElementById("li-pwd").value;
    const errEl = document.getElementById("li-error");
    const s = state.students[id];
    if (!s) { errEl.textContent = "لا يوجد حساب بهذا الرقم الجامعي"; return; }
    const ok = await verifyCredential(pwd, s.salt, s.passwordHash);
    if (!ok) { errEl.textContent = "كلمة المرور غير صحيحة"; return; }
    errEl.textContent = "";
    state.session = { role: "student", id: s.studentId };
    await persistSession();
    toast(`أهلًا ${esc(s.name)} 👋`);
    if (pendingClaimCode) state.tab = "claim";
    renderRoot();
  });
}

/* --- student signup --- */
function renderStudentSignup() {
  selectedTeam = null;
  root.innerHTML = `
    ${authHero()}
    <div class="cw-segment">
      <button class="cw-segment-btn" data-seg="login">تسجيل الدخول</button>
      <button class="cw-segment-btn active" data-seg="signup">حساب جديد</button>
    </div>
    <form class="cw-form" id="reg-form">
      <label class="cw-label">الاسم الكامل</label>
      <input class="cw-input" id="reg-name" placeholder="مثال: محمد علي">

      <label class="cw-label">الرقم الجامعي</label>
      <input class="cw-input" id="reg-id" placeholder="Student ID">

      <label class="cw-label">رقم الهاتف</label>
      <input class="cw-input" id="reg-phone" placeholder="07xxxxxxxxx" inputmode="tel">

      <label class="cw-label">القسم</label>
      <input class="cw-input" id="reg-dept" placeholder="مثال: علوم الحاسوب">

      <label class="cw-label">المرحلة</label>
      <select class="cw-input" id="reg-level">
        ${LEVELS.map(l => `<option value="${esc(l)}">${esc(l)}</option>`).join("")}
      </select>

      <label class="cw-label">كلمة المرور</label>
      <input class="cw-input" type="password" id="reg-pwd" placeholder="6 أحرف على الأقل">

      <label class="cw-label">تأكيد كلمة المرور</label>
      <input class="cw-input" type="password" id="reg-pwd2" placeholder="أعد كتابة كلمة المرور">

      <label class="cw-label">اختر فريقك</label>
      <div class="cw-team-pick" id="reg-team-pick">
        <button type="button" class="cw-team-card coffee" data-team="coffee">
          <span class="cw-team-emoji">☕</span><span>فريق القهوة</span>
        </button>
        <button type="button" class="cw-team-card tea" data-team="tea">
          <span class="cw-team-emoji">🍵</span><span>فريق الشاي</span>
        </button>
      </div>

      <label class="cw-checkbox">
        <input type="checkbox" id="reg-agree">
        <span>أوافق على قوانين المنافسة (تُحسب النقاط فقط من عمليات الشراء الفعلية المسجّلة عبر الإدارة)</span>
      </label>

      <div class="cw-error" id="reg-error"></div>
      <button type="submit" class="cw-btn-primary">إنشاء الحساب 🚀</button>
    </form>
    ${authFooterLinks()}
  `;
  document.querySelector('[data-seg="login"]').addEventListener("click", () => { state.authView = "landing-student"; renderAuth(); });
  document.getElementById("go-admin").addEventListener("click", () => { state.authView = "landing-admin"; renderAuth(); });
  document.getElementById("reg-team-pick").querySelectorAll(".cw-team-card").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedTeam = btn.dataset.team;
      document.querySelectorAll(".cw-team-card").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });
  document.getElementById("reg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("reg-name").value.trim();
    const studentId = document.getElementById("reg-id").value.trim();
    const phone = document.getElementById("reg-phone").value.trim();
    const department = document.getElementById("reg-dept").value.trim() || "غير محدد";
    const level = document.getElementById("reg-level").value;
    const pwd = document.getElementById("reg-pwd").value;
    const pwd2 = document.getElementById("reg-pwd2").value;
    const agree = document.getElementById("reg-agree").checked;
    const errEl = document.getElementById("reg-error");

    if (!name || !studentId) { errEl.textContent = "الرجاء إدخال الاسم والرقم الجامعي"; return; }
    if (!phone || phone.length < 7) { errEl.textContent = "أدخل رقم هاتف صحيح (يُستخدم لاستعادة كلمة المرور)"; return; }
    if (!selectedTeam) { errEl.textContent = "اختر فريقك أولًا"; return; }
    if (pwd.length < 6) { errEl.textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل"; return; }
    if (pwd !== pwd2) { errEl.textContent = "كلمتا المرور غير متطابقتين"; return; }
    if (!agree) { errEl.textContent = "يجب الموافقة على قوانين المنافسة"; return; }
    if (state.students[studentId]) { errEl.textContent = "هذا الرقم الجامعي مسجّل مسبقًا — سجّل الدخول بدلًا من ذلك"; return; }
    errEl.textContent = "";

    const cred = await makeCredential(pwd);
    state.students[studentId] = {
      name, studentId, phone, department, level, team: selectedTeam,
      points: 0, purchases: 0, createdAt: Date.now(),
      salt: cred.salt, passwordHash: cred.passwordHash,
    };
    await persistStudents();
    state.session = { role: "student", id: studentId };
    await persistSession();
    toast("مرحبًا بك في المنافسة! 🎉");
    if (pendingClaimCode) state.tab = "claim";
    renderRoot();
  });
}

/* --- student forgot password: step 1 (identify) --- */
function renderStudentForgot1() {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🔑 استعادة كلمة المرور</h2>
      <div class="cw-card">
        <p class="cw-hint">أدخل رقمك الجامعي، وسنرسل رمز تحقق مكوّن من 6 أرقام إلى رقم هاتفك المسجّل.</p>
        <input class="cw-input" id="fg-id" placeholder="الرقم الجامعي">
        <div class="cw-error" id="fg-error"></div>
        <button class="cw-btn-primary" id="fg-send-btn">إرسال رمز التحقق</button>
        <button class="cw-btn-ghost" id="fg-back">رجوع لتسجيل الدخول</button>
      </div>
    </div>
  `;
  document.getElementById("fg-back").addEventListener("click", () => { state.authView = "landing-student"; renderAuth(); });
  document.getElementById("fg-send-btn").addEventListener("click", async () => {
    const id = document.getElementById("fg-id").value.trim();
    const errEl = document.getElementById("fg-error");
    const s = state.students[id];
    if (!s) { errEl.textContent = "لا يوجد حساب بهذا الرقم الجامعي"; return; }
    if (!s.phone) { errEl.textContent = "لا يوجد رقم هاتف مسجّل لهذا الحساب — راجع الإدارة"; return; }
    errEl.textContent = "";
    await sendOtp("student", s.studentId, s.phone);
  });
}

/* --- admin forgot password: step 1 --- */
function renderAdminForgot1() {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🔑 استعادة كلمة مرور الإدارة</h2>
      <div class="cw-card">
        <p class="cw-hint">سنرسل رمز تحقق مكوّن من 6 أرقام إلى رقم الهاتف المسجّل لحساب الإدارة.</p>
        <div class="cw-error" id="fg-error"></div>
        <button class="cw-btn-primary" id="fg-send-btn">إرسال رمز التحقق</button>
        <button class="cw-btn-ghost" id="fg-back">رجوع لتسجيل الدخول</button>
      </div>
    </div>
  `;
  document.getElementById("fg-back").addEventListener("click", () => { state.authView = "landing-admin"; renderAuth(); });
  document.getElementById("fg-send-btn").addEventListener("click", async () => {
    if (!state.adminAccount) { document.getElementById("fg-error").textContent = "لا يوجد حساب إدارة بعد"; return; }
    await sendOtp("admin", "admin", state.adminAccount.phone);
  });
}

/* --- shared: request a real SMS OTP from the backend --- */
async function sendOtp(kind, id, phone) {
  if (!OTP_API_BASE || OTP_API_BASE.includes("YOUR-BACKEND-URL")) {
    toast("⚠️ لم يتم ربط خادم الرسائل بعد. راجع backend/README.md لنشره، ثم عدّل OTP_API_BASE في script.js", "demo");
    return;
  }
  pendingReset = { kind, id, phone };
  try {
    const res = await fetch(`${OTP_API_BASE}/api/otp/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || "تعذر إرسال رمز التحقق، حاول مرة أخرى");
      return;
    }
    toast(`تم إرسال رمز التحقق إلى ${esc(maskPhone(phone))} 📩`);
    state.authView = (kind === "student" ? "student-forgot-2" : "admin-forgot-2");
    renderAuth();
  } catch (e) {
    toast("تعذر الاتصال بخادم الرسائل — تحقق من الاتصال بالإنترنت");
  }
}

/* --- step 2: enter code (shared for student/admin) --- */
function renderForgot2(kind) {
  const backView = kind === "student" ? "student-forgot-1" : "admin-forgot-1";
  const phone = pendingReset?.phone || (kind === "student" ? state.students[pendingReset?.id]?.phone : state.adminAccount?.phone);
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">✉️ أدخل رمز التحقق</h2>
      <div class="cw-card">
        <p class="cw-hint">أُرسل رمز مكوّن من 6 أرقام كرسالة SMS إلى ${esc(maskPhone(phone))}.</p>
        <input class="cw-input cw-otp-input" id="otp-code" placeholder="000000" maxlength="6" inputmode="numeric">
        <div class="cw-error" id="otp-error"></div>
        <button class="cw-btn-primary" id="otp-verify-btn">تحقق</button>
        <button class="cw-btn-ghost" id="otp-resend-btn">إعادة إرسال الرمز</button>
        <button class="cw-link-btn" id="otp-back">رجوع</button>
      </div>
    </div>
  `;
  document.getElementById("otp-back").addEventListener("click", () => { state.authView = backView; pendingReset = null; renderAuth(); });
  document.getElementById("otp-resend-btn").addEventListener("click", async () => {
    await sendOtp(kind, pendingReset.id, phone);
  });
  document.getElementById("otp-verify-btn").addEventListener("click", async () => {
    const entered = document.getElementById("otp-code").value.trim();
    const errEl = document.getElementById("otp-error");
    if (!/^\d{6}$/.test(entered)) { errEl.textContent = "أدخل رمزًا مكوّنًا من 6 أرقام"; return; }
    try {
      const res = await fetch(`${OTP_API_BASE}/api/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, code: entered }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errEl.textContent = data.error || "الرمز غير صحيح"; return; }
      errEl.textContent = "";
      pendingReset.verifyToken = data.verifyToken;
      state.authView = kind === "student" ? "student-forgot-3" : "admin-forgot-3";
      renderAuth();
    } catch (e) {
      errEl.textContent = "تعذر الاتصال بخادم الرسائل";
    }
  });
}

/* --- step 3: set new password (shared) --- */
function renderForgot3(kind) {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🔒 كلمة مرور جديدة</h2>
      <div class="cw-card">
        <label class="cw-label">كلمة المرور الجديدة</label>
        <input class="cw-input" type="password" id="np-pwd" placeholder="6 أحرف على الأقل">
        <label class="cw-label">تأكيد كلمة المرور</label>
        <input class="cw-input" type="password" id="np-pwd2" placeholder="أعد كتابة كلمة المرور">
        <div class="cw-error" id="np-error"></div>
        <button class="cw-btn-primary" id="np-save-btn">حفظ وتسجيل الدخول</button>
      </div>
    </div>
  `;
  document.getElementById("np-save-btn").addEventListener("click", async () => {
    const pwd = document.getElementById("np-pwd").value;
    const pwd2 = document.getElementById("np-pwd2").value;
    const errEl = document.getElementById("np-error");
    if (!pendingReset?.verifyToken) { errEl.textContent = "انتهت الجلسة — ابدأ من جديد من نسيت كلمة المرور"; return; }
    if (pwd.length < 6) { errEl.textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل"; return; }
    if (pwd !== pwd2) { errEl.textContent = "كلمتا المرور غير متطابقتين"; return; }
    errEl.textContent = "";
    const cred = await makeCredential(pwd);
    if (kind === "student") {
      const s = state.students[pendingReset.id];
      s.salt = cred.salt; s.passwordHash = cred.passwordHash;
      await persistStudents();
      state.session = { role: "student", id: s.studentId };
    } else {
      state.adminAccount.salt = cred.salt; state.adminAccount.passwordHash = cred.passwordHash;
      await persistAdmin();
      state.session = { role: "admin", id: "admin" };
    }
    await persistSession();
    pendingReset = null;
    toast("تم تحديث كلمة المرور ✅");
    renderRoot();
  });
}

/* --- admin login --- */
function renderAdminLogin() {
  if (!state.adminAccount) { state.authView = "admin-setup"; renderAuth(); return; }
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🔒 دخول الإدارة</h2>
      <form class="cw-form" id="admin-login-form" style="padding:0">
        <label class="cw-label">اسم المستخدم</label>
        <input class="cw-input" id="al-user" placeholder="اسم المستخدم">
        <label class="cw-label">كلمة المرور</label>
        <input class="cw-input" type="password" id="al-pwd" placeholder="••••••••">
        <div class="cw-error" id="al-error"></div>
        <button type="submit" class="cw-btn-primary">دخول</button>
        <button type="button" class="cw-link-btn" id="al-forgot">نسيت كلمة المرور؟</button>
        <button type="button" class="cw-btn-ghost" id="al-back">رجوع لحساب الطالب</button>
      </form>
    </div>
  `;
  document.getElementById("al-back").addEventListener("click", () => { state.authView = "landing-student"; renderAuth(); });
  document.getElementById("al-forgot").addEventListener("click", () => { state.authView = "admin-forgot-1"; renderAuth(); });
  document.getElementById("admin-login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = document.getElementById("al-user").value.trim();
    const pwd = document.getElementById("al-pwd").value;
    const errEl = document.getElementById("al-error");
    if (user !== state.adminAccount.username) { errEl.textContent = "بيانات الدخول غير صحيحة"; return; }
    const ok = await verifyCredential(pwd, state.adminAccount.salt, state.adminAccount.passwordHash);
    if (!ok) { errEl.textContent = "بيانات الدخول غير صحيحة"; return; }
    errEl.textContent = "";
    state.session = { role: "admin", id: "admin" };
    await persistSession();
    toast("أهلًا بك في لوحة الإدارة 👋");
    renderRoot();
  });
}

/* --- admin first-time setup --- */
function renderAdminSetup() {
  root.innerHTML = `
    ${authHero()}
    <div class="cw-page">
      <h2 class="cw-section-title">🛠️ إعداد حساب الإدارة (أول مرة)</h2>
      <div class="cw-card">
        <p class="cw-hint">لا يوجد حساب إدارة بعد — أنشئ الحساب الرئيسي الآن. هذه الخطوة تظهر مرة واحدة فقط.</p>
        <form id="admin-setup-form">
          <label class="cw-label">اسم المستخدم</label>
          <input class="cw-input" id="as-user" placeholder="admin">
          <label class="cw-label">رقم الهاتف (لاستعادة كلمة المرور)</label>
          <input class="cw-input" id="as-phone" placeholder="07xxxxxxxxx" inputmode="tel">
          <label class="cw-label">كلمة المرور</label>
          <input class="cw-input" type="password" id="as-pwd" placeholder="6 أحرف على الأقل">
          <label class="cw-label">تأكيد كلمة المرور</label>
          <input class="cw-input" type="password" id="as-pwd2" placeholder="أعد كتابة كلمة المرور">
          <div class="cw-error" id="as-error"></div>
          <button type="submit" class="cw-btn-primary">إنشاء حساب الإدارة</button>
          <button type="button" class="cw-btn-ghost" id="as-back">رجوع</button>
        </form>
      </div>
    </div>
  `;
  document.getElementById("as-back").addEventListener("click", () => { state.authView = "landing-student"; renderAuth(); });
  document.getElementById("admin-setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("as-user").value.trim();
    const phone = document.getElementById("as-phone").value.trim();
    const pwd = document.getElementById("as-pwd").value;
    const pwd2 = document.getElementById("as-pwd2").value;
    const errEl = document.getElementById("as-error");
    if (!username) { errEl.textContent = "أدخل اسم مستخدم"; return; }
    if (!phone || phone.length < 7) { errEl.textContent = "أدخل رقم هاتف صحيح"; return; }
    if (pwd.length < 6) { errEl.textContent = "كلمة المرور يجب أن تكون 6 أحرف على الأقل"; return; }
    if (pwd !== pwd2) { errEl.textContent = "كلمتا المرور غير متطابقتين"; return; }
    errEl.textContent = "";
    const cred = await makeCredential(pwd);
    state.adminAccount = { username, phone, salt: cred.salt, passwordHash: cred.passwordHash, createdAt: Date.now() };
    await persistAdmin();
    state.session = { role: "admin", id: "admin" };
    await persistSession();
    toast("تم إنشاء حساب الإدارة ✅");
    renderRoot();
  });
}

/* =========================================================
   SCORE BAR (shared component)
========================================================= */
function scoreBarHTML(coffee, tea, size) {
  const total = Math.max(coffee + tea, 1);
  const coffeePct = (coffee / total) * 100;
  const diff = coffee - tea;
  let caption;
  if (diff === 0) caption = "🔥 تعادل تام";
  else if (diff > 0) caption = `☕ القهوة متقدمة بـ${diff} نقطة`;
  else caption = `🍵 الشاي متقدم بـ${Math.abs(diff)} نقطة`;
  return `
    <div class="cw-scorebar ${size === "sm" ? "cw-scorebar-sm" : ""}">
      <div class="cw-scorebar-row">
        <div class="cw-team-num coffee">${coffee}</div>
        <div class="cw-vs">VS</div>
        <div class="cw-team-num tea">${tea}</div>
      </div>
      <div class="cw-bar-track">
        <div class="cw-bar-fill coffee" style="width:${coffeePct}%"></div>
        <div class="cw-bar-fill tea" style="width:${100 - coffeePct}%"></div>
      </div>
      <div class="cw-bar-caption">${caption}</div>
    </div>
  `;
}
function miniProgressHTML(challenge) {
  const { target, teamProgress } = challenge;
  return `<div class="cw-mini-progress">` + Object.entries(TEAM_META).map(([key, t]) => {
    const val = Math.min(teamProgress[key] || 0, target);
    const pct = (val / target) * 100;
    return `
      <div class="cw-mini-row">
        <span class="cw-mini-label">${t.emoji}</span>
        <div class="cw-mini-track"><div class="cw-mini-fill ${key}" style="width:${pct}%"></div></div>
        <span class="cw-mini-num">${val}/${target}</span>
      </div>`;
  }).join("") + `</div>`;
}

/* =========================================================
   STUDENT APP
========================================================= */
function renderStudentApp() {
  root.innerHTML = `
    <div class="cw-content" id="tab-content"></div>
    <nav class="cw-nav" id="nav">
      ${navButton("home", "🏠", "الرئيسية")}
      ${navButton("leaderboard", "🏆", "المتصدرون")}
      ${navButton("challenges", "🎯", "التحديات")}
      ${navButton("profile", "👤", "حسابي")}
    </nav>
  `;
  wireNav();
  renderTab();
}
function navButton(id, icon, label) {
  return `<button class="cw-nav-btn ${state.tab === id ? "active" : ""}" data-tab="${id}">
    <span class="icon">${icon}</span><span>${label}</span>
  </button>`;
}
function wireNav() {
  document.getElementById("nav").querySelectorAll("[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => { state.tab = btn.dataset.tab; renderRoot(); });
  });
}
function renderTab() {
  const c = document.getElementById("tab-content");
  if (state.tab === "claim") { c.innerHTML = claimCodeHTML(); wireClaimCode(); return; }
  if (state.tab === "home") {
    c.innerHTML = homeHTML();
    document.getElementById("home-claim-btn")?.addEventListener("click", () => { state.tab = "claim"; renderTab(); });
  }
  else if (state.tab === "leaderboard") c.innerHTML = leaderboardHTML();
  else if (state.tab === "challenges") c.innerHTML = challengesHTML();
  else if (state.tab === "profile") { c.innerHTML = profileHTML(); wireProfile(); }
}

/* --- claim screen: reached via QR link (?claim=CODE) or manual entry --- */
function claimCodeHTML() {
  const code = pendingClaimCode || "";
  return `
    <div class="cw-page">
      <div class="cw-hero-mini">
        <div class="cw-hero-badge small">🧾</div>
        <h1 class="cw-title small">رمز شراء</h1>
      </div>
      <div class="cw-card" id="claim-box">
        <div class="cw-card-title">استلام نقطة شراء</div>
        ${code
          ? `<p class="cw-hint">الرمز: <b style="font-family:var(--font-mono); color:var(--gold)">${esc(code)}</b></p>
             <p class="cw-hint">اضغط الزر لتأكيد استلام النقطة لحسابك.</p>`
          : `<p class="cw-hint">اطلب من الإدارة رمز الشراء بعد ما تدفع، وأدخله هنا.</p>
             <input class="cw-input cw-gate-input" id="claim-code-input" placeholder="رمز الشراء" autocomplete="off">`
        }
        <div class="cw-error" id="claim-error"></div>
        <button class="cw-btn-primary" id="claim-confirm-btn">استلم نقطتك 🎉</button>
        <button class="cw-btn-ghost" id="claim-skip-btn">${code ? "تجاهل والعودة للرئيسية" : "رجوع"}</button>
      </div>
    </div>
  `;
}
function wireClaimCode() {
  const finish = () => {
    pendingClaimCode = null;
    stripClaimFromUrl();
    state.tab = "home";
    renderRoot();
  };
  document.getElementById("claim-skip-btn").addEventListener("click", finish);
  document.getElementById("claim-confirm-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const errEl = document.getElementById("claim-error");
    const manualInput = document.getElementById("claim-code-input");
    const code = pendingClaimCode || (manualInput ? manualInput.value.trim().toUpperCase() : "");
    if (!code) { errEl.textContent = "أدخل رمز الشراء"; return; }
    btn.disabled = true; btn.textContent = "جارِ التحقق...";
    const res = await claimPurchaseCode(code, state.session.id);
    if (!res.ok) {
      errEl.textContent = res.reason;
      btn.disabled = false; btn.textContent = "استلم نقطتك 🎉";
      return;
    }
    toast(`🎉 +${res.points} نقطة! تم استلامها بنجاح`);
    finish();
  });
}

function homeHTML() {
  const totals = computeTeamTotals();
  const m = me();
  const rank = myRank();
  const total = computeRanking().length;
  const activeChallenge = state.challenges.find(c => c.active);
  const latestNews = state.news[0];
  return `
    <div class="cw-page">
      <div class="cw-hero-mini">
        <img class="cw-hero-logo small" src="assets/logo-icon.png" alt="BREZZO">
        <h1 class="cw-title small">CUP WAR</h1>
      </div>
      ${state.settings.doublePointsActive ? `
        <div class="cw-banner double">⚡ نقاط مضاعفة الآن! كل عملية شراء = نقطتان ${state.settings.doubleNote ? "— " + esc(state.settings.doubleNote) : ""}</div>
      ` : ""}
      ${scoreBarHTML(totals.totals.coffee, totals.totals.tea)}
      <div class="cw-card cw-me-card">
        <div class="cw-me-team">${TEAM_META[m.team].emoji} <span>${TEAM_META[m.team].label}</span></div>
        <div class="cw-me-row">
          <div class="cw-stat"><span class="cw-stat-num">${m.points}</span><span class="cw-stat-label">نقاطك</span></div>
          <div class="cw-stat"><span class="cw-stat-num">#${rank || "-"}</span><span class="cw-stat-label">من ${total}</span></div>
          <div class="cw-stat"><span class="cw-stat-num">${m.purchases}</span><span class="cw-stat-label">مشترياتك</span></div>
        </div>
        <button class="cw-btn-small" id="home-claim-btn" style="width:100%; justify-content:center; margin-top:4px;">🧾 عندك رمز شراء؟ سجّله هنا</button>
      </div>
      ${activeChallenge ? `
        <div class="cw-card">
          <div class="cw-card-title">🎯 تحدي اليوم</div>
          <div class="cw-challenge-name">${esc(activeChallenge.title)}</div>
          ${miniProgressHTML(activeChallenge)}
        </div>` : ""}
      ${latestNews ? `
        <div class="cw-card">
          <div class="cw-card-title">📢 آخر الأخبار</div>
          <div class="cw-news-text">${esc(latestNews.text)}</div>
        </div>` : ""}
    </div>
  `;
}

function leaderboardHTML() {
  const totals = computeTeamTotals();
  const ranking = computeRanking();
  const m = me();
  return `
    <div class="cw-page">
      <h2 class="cw-section-title">🏆 Leaderboard</h2>
      ${scoreBarHTML(totals.totals.coffee, totals.totals.tea, "sm")}
      <div class="cw-card" style="padding:0">
        ${ranking.length === 0 ? `<div class="cw-empty">لا يوجد طلاب مسجّلون بعد</div>` :
          ranking.slice(0, 30).map((s, i) => `
            <div class="cw-rank-row ${m && s.studentId === m.studentId ? "me" : ""}">
              <div class="cw-rank-num ${i < 3 ? "top" : ""}">${i + 1}</div>
              <div class="cw-rank-info">
                <div class="cw-rank-name">${esc(s.name)}</div>
                <div class="cw-rank-sub">${TEAM_META[s.team].emoji} ${esc(s.department)}</div>
              </div>
              <div class="cw-rank-pts">${s.points}</div>
            </div>`).join("")}
      </div>
    </div>
  `;
}

function challengesHTML() {
  const active = state.challenges.filter(c => c.active);
  const done = state.challenges.filter(c => !c.active);
  return `
    <div class="cw-page">
      <h2 class="cw-section-title">🎯 التحديات</h2>
      ${active.length === 0 ? `<div class="cw-card cw-empty">لا توجد تحديات نشطة حاليًا — ترقّب!</div>` : ""}
      ${active.map(c => `
        <div class="cw-card">
          <div class="cw-challenge-name">${esc(c.title)}</div>
          ${c.description ? `<div class="cw-challenge-desc">${esc(c.description)}</div>` : ""}
          ${miniProgressHTML(c)}
          <div class="cw-challenge-reward">🏆 الجائزة: +${c.rewardPoints} نقطة لفريق الفريق الفائز</div>
        </div>`).join("")}
      ${done.length > 0 ? `
        <h3 class="cw-section-title small">تحديات سابقة</h3>
        ${done.map(c => `
          <div class="cw-card muted">
            <div class="cw-challenge-name">${esc(c.title)}</div>
            <div class="cw-challenge-desc">${c.awarded ? "انتهى ✅ تم منح الجائزة" : "غير نشط"}</div>
          </div>`).join("")}
      ` : ""}
    </div>
  `;
}

function profileHTML() {
  const m = me();
  const rank = myRank();
  const total = computeRanking().length;
  const earned = BADGE_DEFS.filter(b => b.test(m));
  return `
    <div class="cw-page">
      <h2 class="cw-section-title">👤 حسابي</h2>
      <div class="cw-card cw-profile-card">
        <div class="cw-profile-avatar ${m.team}">${TEAM_META[m.team].emoji}</div>
        <div class="cw-profile-name">${esc(m.name)}</div>
        <div class="cw-profile-sub">${esc(m.department)} • ${esc(m.level)}</div>
        <div class="cw-profile-team">${TEAM_META[m.team].label}</div>
      </div>
      <div class="cw-card">
        <div class="cw-me-row">
          <div class="cw-stat"><span class="cw-stat-num">${m.points}</span><span class="cw-stat-label">نقاطك</span></div>
          <div class="cw-stat"><span class="cw-stat-num">#${rank}</span><span class="cw-stat-label">من ${total}</span></div>
          <div class="cw-stat"><span class="cw-stat-num">${m.purchases}</span><span class="cw-stat-label">مشترياتك</span></div>
        </div>
      </div>
      <div class="cw-card">
        <div class="cw-card-title">🎖️ الأوسمة</div>
        ${earned.length === 0 ? `<div class="cw-empty">ما زلت بدون أوسمة — أول عملية شراء تفتح أول وسام!</div>` :
          `<div class="cw-badges">${earned.map(b => `<div class="cw-badge"><span>${b.icon}</span>${b.label}</div>`).join("")}</div>`}
      </div>
      <div class="cw-card">
        <div class="cw-card-title">🔒 تغيير كلمة المرور</div>
        <input class="cw-input" type="password" id="cp-old" placeholder="كلمة المرور الحالية">
        <input class="cw-input" type="password" id="cp-new" placeholder="كلمة المرور الجديدة" style="margin-top:8px">
        <div class="cw-error" id="cp-error"></div>
        <button class="cw-btn-small" id="cp-save-btn" style="margin-top:8px">حفظ</button>
      </div>
      <button class="cw-btn-ghost" id="logout-btn">🚪 تسجيل خروج</button>
    </div>
  `;
}
function wireProfile() {
  document.getElementById("logout-btn").addEventListener("click", async () => {
    state.session = null;
    await persistSession();
    state.authView = "landing-student";
    renderRoot();
  });
  document.getElementById("cp-save-btn").addEventListener("click", async () => {
    const m = me();
    const oldPwd = document.getElementById("cp-old").value;
    const newPwd = document.getElementById("cp-new").value;
    const errEl = document.getElementById("cp-error");
    const ok = await verifyCredential(oldPwd, m.salt, m.passwordHash);
    if (!ok) { errEl.textContent = "كلمة المرور الحالية غير صحيحة"; return; }
    if (newPwd.length < 6) { errEl.textContent = "كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل"; return; }
    errEl.textContent = "";
    const cred = await makeCredential(newPwd);
    m.salt = cred.salt; m.passwordHash = cred.passwordHash;
    await persistStudents();
    toast("تم تحديث كلمة المرور ✅");
    document.getElementById("cp-old").value = "";
    document.getElementById("cp-new").value = "";
  });
}

/* =========================================================
   ADMIN APP
========================================================= */
function renderAdminApp() {
  const sections = [
    ["purchase", "المشتريات"], ["challenges", "التحديات"], ["double", "مضاعفة"],
    ["news", "الأخبار"], ["rewards", "الجوائز"], ["stats", "إحصائيات"],
  ];
  root.innerHTML = `
    <div class="cw-content">
      <div class="cw-page">
        <div class="cw-admin-topbar">
          <h2 class="cw-section-title">🔒 لوحة الإدارة</h2>
          <button class="cw-icon-btn" id="admin-logout">🚪</button>
        </div>
        <div class="cw-chip-row" id="admin-chips">
          ${sections.map(([id, label]) => `<button class="cw-chip ${state.adminSection === id ? "active" : ""}" data-section="${id}">${label}</button>`).join("")}
        </div>
        <div id="admin-section-body"></div>
      </div>
    </div>
  `;
  document.getElementById("admin-logout").addEventListener("click", async () => {
    state.session = null;
    await persistSession();
    state.authView = "landing-admin";
    renderRoot();
  });
  document.getElementById("admin-chips").querySelectorAll("[data-section]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.adminSection = btn.dataset.section;
      document.querySelectorAll("#admin-chips .cw-chip").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      renderAdminSection();
    });
  });
  renderAdminSection();
}

function renderAdminSection() {
  const body = document.getElementById("admin-section-body");
  const sec = state.adminSection;
  if (sec === "purchase") { body.innerHTML = adminPurchaseHTML(); wireAdminPurchase(); }
  else if (sec === "challenges") { body.innerHTML = adminChallengesHTML(); wireAdminChallenges(); }
  else if (sec === "double") { body.innerHTML = adminDoubleHTML(); wireAdminDouble(); }
  else if (sec === "news") { body.innerHTML = adminNewsHTML(); wireAdminNews(); }
  else if (sec === "rewards") { body.innerHTML = adminRewardsHTML(); wireAdminRewards(); }
  else if (sec === "stats") { body.innerHTML = adminStatsHTML(); }
}

function adminPurchaseHTML() {
  return `
    <div class="cw-card">
      <div class="cw-card-title">🧾 توليد رمز شراء (QR)</div>
      ${state.settings.doublePointsActive ? `<div class="cw-banner double small">⚡ المضاعفة مفعّلة الآن — الرمز القادم بـ2 نقطة</div>` : ""}
      <p class="cw-hint">بعد ما الزبون يدفع فعليًا، اضغط الزر وخلّه يمسح الرمز بكاميرا هاتفه العادية — النقطة تُسجَّل لحسابه تلقائيًا. الرمز صالح 15 دقيقة ويُستخدم مرة وحدة بس.</p>
      <button class="cw-btn-primary" id="gen-code-btn">توليد رمز شراء جديد</button>
      <div id="code-display"></div>
    </div>
    <div class="cw-card">
      <div class="cw-card-title">🔍 أو ابحث وسجّل يدويًا</div>
      <input class="cw-input" id="ap-search" placeholder="ابحث بالاسم أو الرقم الجامعي">
      <div class="cw-purchase-list" id="ap-list"></div>
    </div>
  `;
}
let codePollInterval = null;
function stopCodePolling() { if (codePollInterval) { clearInterval(codePollInterval); codePollInterval = null; } }
function renderCodeDisplay(record) {
  const el = document.getElementById("code-display");
  if (!el) return;
  if (record.used) {
    el.innerHTML = `
      <div class="cw-code-result used">
        <div class="cw-code-check">✅</div>
        <div>تم الاستلام من قِبل <b>${esc(record.usedByName)}</b> — +${record.points} نقطة</div>
      </div>`;
    stopCodePolling();
    return;
  }
  const secondsLeft = Math.max(0, Math.round((record.expiresAt - Date.now()) / 1000));
  const claimUrl = buildClaimUrl(record.code);
  const qrImg = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(claimUrl)}`;
  el.innerHTML = `
    <div class="cw-code-result">
      <img class="cw-code-qr" src="${qrImg}" alt="QR" width="180" height="180">
      <div class="cw-code-text">${record.code}</div>
      <div class="cw-code-wait">⏳ بانتظار المسح... تنتهي الصلاحية خلال ${secondsLeft} ثانية</div>
    </div>`;
}
async function refreshCurrentCode(code) {
  const fresh = await getKey("purchaseCodes", true);
  if (fresh) state.purchaseCodes = fresh;
  const record = state.purchaseCodes[code];
  if (!record) { stopCodePolling(); return; }
  if (Date.now() > record.expiresAt && !record.used) {
    const el = document.getElementById("code-display");
    if (el) el.innerHTML = `<div class="cw-code-result"><div class="cw-hint">⌛ انتهت صلاحية الرمز. ولّد رمزًا جديدًا للزبون التالي.</div></div>`;
    stopCodePolling();
    return;
  }
  renderCodeDisplay(record);
}
function wireAdminPurchase() {
  document.getElementById("ap-search").addEventListener("input", renderPurchaseList);
  renderPurchaseList();
  document.getElementById("gen-code-btn").addEventListener("click", async () => {
    stopCodePolling();
    const record = await createPurchaseCode();
    renderCodeDisplay(record);
    codePollInterval = setInterval(() => refreshCurrentCode(record.code), 3000);
  });
}
function renderPurchaseList() {
  const q = (document.getElementById("ap-search")?.value || "").trim();
  const list = Object.values(state.students)
    .filter(s => !q || s.name.includes(q) || s.studentId.includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, "ar"))
    .slice(0, 25);
  const listEl = document.getElementById("ap-list");
  listEl.innerHTML = list.length === 0 ? `<div class="cw-empty">لا نتائج</div>` :
    list.map(s => `
      <div class="cw-purchase-row">
        <div>
          <div class="cw-rank-name">${esc(s.name)}</div>
          <div class="cw-rank-sub">${TEAM_META[s.team].emoji} ${esc(s.studentId)} • ${s.points} نقطة</div>
        </div>
        <button class="cw-btn-small" data-purchase="${esc(s.studentId)}">+ شراء</button>
      </div>`).join("");
  listEl.querySelectorAll("[data-purchase]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.purchase;
      const s = state.students[sid];
      if (!s) return;
      const pts = state.settings.doublePointsActive ? 2 : 1;
      s.points += pts; s.purchases += 1;
      await persistStudents();
      toast(`+${pts} نقطة لـ ${s.name}`);
      renderPurchaseList();
    });
  });
}
function wireAdminPurchase() {
  document.getElementById("ap-search").addEventListener("input", renderPurchaseList);
  renderPurchaseList();
}

function adminChallengesHTML() {
  return `
    <div class="cw-card">
      <div class="cw-card-title">➕ إنشاء تحدي جديد</div>
      <input class="cw-input" id="ch-title" placeholder="عنوان التحدي">
      <input class="cw-input" id="ch-desc" placeholder="الوصف (اختياري)" style="margin-top:8px">
      <div class="cw-input-row" style="margin-top:8px">
        <div style="flex:1"><label class="cw-label">الهدف (عدد)</label><input class="cw-input" type="number" id="ch-target" value="50"></div>
        <div style="flex:1"><label class="cw-label">جائزة الفريق الفائز</label><input class="cw-input" type="number" id="ch-reward" value="10"></div>
      </div>
      <div class="cw-error" id="ch-error"></div>
      <button class="cw-btn-primary" id="ch-add-btn">إضافة التحدي</button>
    </div>
    <div id="challenge-list"></div>
  `;
}
function renderChallengeList() {
  const listEl = document.getElementById("challenge-list");
  listEl.innerHTML = state.challenges.map(c => `
    <div class="cw-card" style="margin-top:12px">
      <div class="cw-card-title-row">
        <div class="cw-challenge-name">${esc(c.title)}</div>
        <button class="cw-icon-btn" data-del-challenge="${c.id}">✕</button>
      </div>
      ${Object.entries(TEAM_META).map(([key, t]) => `
        <div class="cw-admin-bump-row">
          <span>${t.emoji} ${t.label}</span>
          <div class="cw-bump-controls">
            <button class="cw-icon-btn" data-bump="${c.id}|${key}|-1">−</button>
            <span class="cw-bump-val">${c.teamProgress[key] || 0} / ${c.target}</span>
            <button class="cw-icon-btn" data-bump="${c.id}|${key}|1">+</button>
          </div>
        </div>`).join("")}
      <div class="cw-admin-actions">
        <button class="cw-btn-small ghost" data-toggle-challenge="${c.id}">${c.active ? "إيقاف" : "تفعيل"}</button>
        ${!c.awarded ? `
          <button class="cw-btn-small" data-award="${c.id}|coffee">✅ فوز القهوة</button>
          <button class="cw-btn-small" data-award="${c.id}|tea">✅ فوز الشاي</button>
        ` : ""}
      </div>
    </div>
  `).join("");

  listEl.querySelectorAll("[data-bump]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const [id, team, delta] = btn.dataset.bump.split("|");
      const c = state.challenges.find(x => x.id === id);
      if (!c) return;
      c.teamProgress[team] = Math.max(0, (c.teamProgress[team] || 0) + Number(delta));
      await persistChallenges();
      renderChallengeList();
    });
  });
  listEl.querySelectorAll("[data-toggle-challenge]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const c = state.challenges.find(x => x.id === btn.dataset.toggleChallenge);
      c.active = !c.active;
      await persistChallenges();
      renderChallengeList();
    });
  });
  listEl.querySelectorAll("[data-award]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const [id, team] = btn.dataset.award.split("|");
      const c = state.challenges.find(x => x.id === id);
      if (!c) return;
      state.teamBonus[team] = (state.teamBonus[team] || 0) + c.rewardPoints;
      await persistTeamBonus();
      c.awarded = true; c.active = false;
      await persistChallenges();
      toast(`منحت ${TEAM_META[team].label} ${c.rewardPoints} نقطة 🏆`);
      renderChallengeList();
    });
  });
  listEl.querySelectorAll("[data-del-challenge]").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.challenges = state.challenges.filter(x => x.id !== btn.dataset.delChallenge);
      await persistChallenges();
      renderChallengeList();
    });
  });
}
function wireAdminChallenges() {
  document.getElementById("ch-add-btn").addEventListener("click", async () => {
    const title = document.getElementById("ch-title").value.trim();
    const description = document.getElementById("ch-desc").value.trim();
    const target = Number(document.getElementById("ch-target").value) || 1;
    const rewardPoints = Number(document.getElementById("ch-reward").value) || 0;
    const errEl = document.getElementById("ch-error");
    if (!title) { errEl.textContent = "أدخل عنوان التحدي"; return; }
    errEl.textContent = "";
    state.challenges.push({
      id: uid(), title, description, target, rewardPoints,
      teamProgress: { coffee: 0, tea: 0 }, active: true, awarded: false, createdAt: Date.now(),
    });
    await persistChallenges();
    document.getElementById("ch-title").value = "";
    document.getElementById("ch-desc").value = "";
    renderChallengeList();
  });
  renderChallengeList();
}

function adminDoubleHTML() {
  return `
    <div class="cw-card">
      <div class="cw-card-title">⚡ نقاط مضاعفة</div>
      <p class="cw-hint">عند التفعيل، كل عملية شراء تُسجَّل لاحقًا تُحتسب بنقطتين بدلًا من نقطة.</p>
      <button class="cw-btn-toggle ${state.settings.doublePointsActive ? "on" : ""}" id="dp-toggle-btn">
        ${state.settings.doublePointsActive ? "إيقاف المضاعفة" : "تفعيل المضاعفة"}
      </button>
      <label class="cw-label">ملاحظة (مثال: من 10 إلى 12)</label>
      <input class="cw-input" id="dp-note" value="${esc(state.settings.doubleNote)}">
    </div>
  `;
}
function wireAdminDouble() {
  document.getElementById("dp-toggle-btn").addEventListener("click", async () => {
    state.settings.doublePointsActive = !state.settings.doublePointsActive;
    await persistSettings();
    renderAdminSection();
  });
  document.getElementById("dp-note").addEventListener("change", async (e) => {
    state.settings.doubleNote = e.target.value;
    await persistSettings();
  });
}

function adminNewsHTML() {
  return `
    <div class="cw-card">
      <div class="cw-card-title">📢 إضافة خبر</div>
      <input class="cw-input" id="news-text" placeholder="نص الإعلان">
      <button class="cw-btn-primary" id="news-add-btn">نشر</button>
    </div>
    <div id="news-list"></div>
  `;
}
function renderNewsList() {
  const el = document.getElementById("news-list");
  el.innerHTML = state.news.map(n => `
    <div class="cw-card cw-news-row" style="margin-top:10px">
      <span>${esc(n.text)}</span>
      <button class="cw-icon-btn" data-del-news="${n.id}">✕</button>
    </div>`).join("");
  el.querySelectorAll("[data-del-news]").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.news = state.news.filter(n => n.id !== btn.dataset.delNews);
      await persistNews();
      renderNewsList();
    });
  });
}
function wireAdminNews() {
  document.getElementById("news-add-btn").addEventListener("click", async () => {
    const input = document.getElementById("news-text");
    const text = input.value.trim();
    if (!text) return;
    state.news.unshift({ id: uid(), text, createdAt: Date.now() });
    await persistNews();
    input.value = "";
    renderNewsList();
  });
  renderNewsList();
}

function adminRewardsHTML() {
  return `
    <div class="cw-card">
      <div class="cw-card-title">🎁 إضافة جائزة</div>
      <input class="cw-input" id="rw-title" placeholder="عنوان الجائزة">
      <input class="cw-input" id="rw-desc" placeholder="الوصف" style="margin-top:8px">
      <button class="cw-btn-primary" id="rw-add-btn">إضافة</button>
    </div>
    <div id="rewards-list"></div>
  `;
}
function renderRewardsList() {
  const el = document.getElementById("rewards-list");
  el.innerHTML = state.rewards.map(r => `
    <div class="cw-card cw-news-row" style="margin-top:10px">
      <div>
        <div class="cw-rank-name">${esc(r.title)}</div>
        <div class="cw-rank-sub">${esc(r.description)}</div>
      </div>
      <button class="cw-icon-btn" data-del-reward="${r.id}">✕</button>
    </div>`).join("");
  el.querySelectorAll("[data-del-reward]").forEach(btn => {
    btn.addEventListener("click", async () => {
      state.rewards = state.rewards.filter(r => r.id !== btn.dataset.delReward);
      await persistRewards();
      renderRewardsList();
    });
  });
}
function wireAdminRewards() {
  document.getElementById("rw-add-btn").addEventListener("click", async () => {
    const titleEl = document.getElementById("rw-title");
    const descEl = document.getElementById("rw-desc");
    const title = titleEl.value.trim();
    const description = descEl.value.trim();
    if (!title) return;
    state.rewards.push({ id: uid(), title, description });
    await persistRewards();
    titleEl.value = ""; descEl.value = "";
    renderRewardsList();
  });
  renderRewardsList();
}

function adminStatsHTML() {
  const list = Object.values(state.students);
  const totals = computeTeamTotals();
  const top5 = [...list].sort((a, b) => b.purchases - a.purchases).slice(0, 5);
  const totalPurchases = list.reduce((sum, s) => sum + s.purchases, 0);
  return `
    <div class="cw-card">
      <div class="cw-card-title">📊 نظرة عامة</div>
      <div class="cw-stats-grid">
        <div class="cw-stat-box"><span class="cw-stat-num">${list.length}</span><span class="cw-stat-label">إجمالي الطلاب</span></div>
        <div class="cw-stat-box"><span class="cw-stat-num">${totalPurchases}</span><span class="cw-stat-label">إجمالي المشتريات</span></div>
        <div class="cw-stat-box"><span class="cw-stat-num">${totals.members.coffee || 0}</span><span class="cw-stat-label">☕ أعضاء</span></div>
        <div class="cw-stat-box"><span class="cw-stat-num">${totals.members.tea || 0}</span><span class="cw-stat-label">🍵 أعضاء</span></div>
      </div>
      <div class="cw-card-title" style="margin-top:12px">🏅 الأكثر شراءً</div>
      ${top5.length === 0 ? `<div class="cw-empty">لا بيانات بعد</div>` : top5.map((s, i) => `
        <div class="cw-rank-row plain">
          <div class="cw-rank-num">${i + 1}</div>
          <div class="cw-rank-info">
            <div class="cw-rank-name">${esc(s.name)}</div>
            <div class="cw-rank-sub">${TEAM_META[s.team].emoji} ${s.purchases} مشترى</div>
          </div>
        </div>`).join("")}
    </div>
  `;
}

/* ---------- go ---------- */
init();
