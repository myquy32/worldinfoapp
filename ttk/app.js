// CLONE OFFLINE (hitreward): SEM banco de dados. Nao existe /api/analysis aqui,
// entao todo o estado vive no localStorage do proprio aparelho do cliente.
var SERVER_SYNC = false;

var DAY_MS = 24 * 60 * 60 * 1000;

var STEP_ICONS = [
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/><polyline points="17 14 19 16 23 12"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
];

// Timeline da análise — condicional pela variante (A=documentos, B=conta de recebimento).
// É função (não array fixo) porque a variante só é conhecida em runtime, por email.
function getSteps() {
  return [
    { label: txt("Documents received", "Account received"), status: txt("Documents received — awaiting initial verification", "Payout account received — awaiting initial verification") },
    { label: txt("Identity verification", "Account verification"), status: txt("Identity being verified — credit analysis started", "Account being verified — credit analysis started") },
    { label: "Credit analysis", status: txt("Credit analysis in progress — documents verified", "Credit analysis in progress — account verified") },
    { label: "Security verification", status: "Security verification in progress — please wait" },
    { label: "Pre-approval", status: "Pre-approval issued — final verification phase" },
    { label: "Final review", status: "Final review — bank data confirmation" },
    { label: "Final result", status: "Final result being issued — awaiting the team's decision" },
  ];
}

// Timeline do PAGAMENTO (fase 2) — depois de aprovado e informada a conta de recebimento.
// São 6 passos (chega em 4 a 6 dias úteis).
function getPayoutSteps() {
  return [
    { label: "Payment approved", status: "Payment approved — your funds were released" },
    { label: "Preparing transfer", status: "Preparing your transfer to the payout account" },
    { label: "Processing", status: "Processing with the payment network" },
    { label: "Sending funds", status: "Sending the funds to your account" },
    { label: "Final confirmation", status: "Final confirmation — almost there" },
    { label: "Payment completed", status: "Payment completed — funds delivered to your account" },
  ];
}

var state = { email: null, analysisStart: null, activeTab: "home", serverDay: null, manualReview: false, manualStart: null, manualServerDay: null, variant: null };

function loadState() {
  try {
    state.email = localStorage.getItem("tk_email") || null;
    var start = localStorage.getItem("tk_analysisStart");
    state.analysisStart = start ? parseInt(start, 10) : null;
    state.manualReview = localStorage.getItem("tk_manualReview") === "1";
    var ms = localStorage.getItem("tk_manualStart");
    state.manualStart = ms ? parseInt(ms, 10) : null;
  } catch (e) { state = { email: null, analysisStart: null, activeTab: "home", manualReview: false, manualStart: null }; }
}

function saveState() {
  try {
    if (state.email) localStorage.setItem("tk_email", state.email); else localStorage.removeItem("tk_email");
    if (state.analysisStart) localStorage.setItem("tk_analysisStart", String(state.analysisStart));
    else localStorage.removeItem("tk_analysisStart");
    if (state.manualReview) localStorage.setItem("tk_manualReview", "1"); else localStorage.removeItem("tk_manualReview");
    if (state.manualStart) localStorage.setItem("tk_manualStart", String(state.manualStart));
    else localStorage.removeItem("tk_manualStart");
  } catch (e) {}
}

function clearState() {
  state = { email: null, analysisStart: null, activeTab: "home", serverDay: null, manualReview: false, manualStart: null, manualServerDay: null };
  try {
    localStorage.removeItem("tk_email"); localStorage.removeItem("tk_analysisStart");
    localStorage.removeItem("tk_manualReview"); localStorage.removeItem("tk_manualStart");
  } catch (e) {}
}

// Dia do PAGAMENTO (fase 2): quantos dias desde que a conta de recebimento foi enviada.
// Usa o dia do SERVIDOR quando disponível (à prova de burlar o relógio e segue a pessoa
// pelo email); cai no cálculo local só como fallback offline. Capado em 6 — o dinheiro
// chega em até 6 dias úteis. (Reaproveita a coluna manual_started_at do servidor.)
function getManualDay() {
  var raw;
  if (typeof state.manualServerDay === "number" && state.manualServerDay > 0) raw = state.manualServerDay;
  else if (!state.manualStart) raw = 1;
  else raw = Math.floor((Date.now() - state.manualStart) / DAY_MS) + 1;
  return Math.min(6, Math.max(1, raw));
}

// Sincroniza com o servidor (Supabase via /api/analysis).
// action "get"   -> busca a data de inicio real; migra clientes antigos (localStartedAt).
// action "start" -> grava a data de inicio no servidor (se ainda nao houver).
// O servidor e a FONTE DA VERDADE do dia: nao da pra burlar mexendo no relogio.
// Se a API falhar (offline/erro), retorna null e o app segue com o localStorage.
async function syncWithServer(action) {
  if (!SERVER_SYNC) return null; // clone offline: segue so pelo localStorage
  if (!state.email) return null;
  var ctrl = null, timer = null;
  try {
    // timeout de 8s: se o servidor demorar, aborta e cai no fallback do localStorage
    if (typeof AbortController !== "undefined") {
      ctrl = new AbortController();
      timer = setTimeout(function () { ctrl.abort(); }, 8000);
    }
    var res = await fetch("/api/analysis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: state.email,
        action: action || "get",
        localStartedAt: state.analysisStart || null,
        localManualStartedAt: state.manualStart || null, // migra quem estava no meio do fluxo só no navegador
      }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return null;
    var data = await res.json();
    if (!data || !data.ok) return null;
    if (data.startedAt) state.analysisStart = new Date(data.startedAt).getTime();
    state.serverDay = data.hasStarted ? data.day : 0;
    // Revisão manual: o SERVIDOR é a fonte da verdade — assim o estado segue a pessoa
    // pelo email em qualquer navegador, mesmo que ela limpe o cache.
    state.manualReview = !!data.manualHasStarted;
    if (data.manualStartedAt) state.manualStart = new Date(data.manualStartedAt).getTime();
    state.manualServerDay = data.manualHasStarted ? (data.manualDay || 0) : null;
    // TESTE A/B: servidor é a fonte da verdade da variante (fixa por email).
    if (data.variant === "A" || data.variant === "B") {
      state.variant = data.variant;
      try { localStorage.setItem(variantKey(), data.variant); } catch (e) {}
    }
    // GANHOS DA EARN: servidor é a fonte da verdade (nunca diminui). Reflete no localStorage.
    if (typeof data.earnTotal === "number" && state.email) {
      try { localStorage.setItem("tk_earn_total:" + state.email, String(data.earnTotal)); } catch (e) {}
    }
    if (data.earnDay && state.email) {
      try { localStorage.setItem("tk_earn_day:" + state.email, JSON.stringify(data.earnDay)); } catch (e) {}
    }
    saveState();
    return data;
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Dia autoritativo: usa o do SERVIDOR quando disponível (à prova de burlar o relógio);
// cai no cálculo local só como fallback offline. Toda a UI e a oferta usam esta função.
function getCurrentDay() {
  if (typeof state.serverDay === "number" && state.serverDay > 0) return state.serverDay;
  if (!state.analysisStart) return 0;
  var elapsed = Date.now() - state.analysisStart;
  var raw = Math.floor(elapsed / DAY_MS) + 1;
  return Math.min(7, Math.max(1, raw));
}

function showToast(text, type) {
  var t = document.getElementById("toast");
  if (!t) return;
  t.className = "toast";
  t.textContent = text;
  if (type) t.classList.add(type);
  clearTimeout(window._toastTimer);
  void t.offsetWidth;
  t.classList.remove("hide");
  t.classList.add("show");
  window._toastTimer = setTimeout(function () {
    t.classList.remove("show");
    t.classList.add("hide");
  }, 3000);
}

// ===== TAB SYSTEM =====

function switchTab(tabId) {
  state.activeTab = tabId;
  var tabs = document.querySelectorAll(".tab-content");
  for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("active");
  var target = document.getElementById("tab-" + tabId);
  if (target) target.classList.add("active");

  var items = document.querySelectorAll(".bn-item");
  for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
  var activeItem = document.querySelector('.bn-item[data-tab="' + tabId + '"]');
  if (activeItem) activeItem.classList.add("active");
}

// ===== ROUTING =====

function route() {
  if (!state.email) {
    document.getElementById("screen-login").classList.add("active");
    document.getElementById("app-shell").classList.remove("active");
  } else {
    document.getElementById("screen-login").classList.remove("active");
    document.getElementById("app-shell").classList.add("active");
    renderHome();
    renderAnalysis();
    renderEarn();
    applyFaqVariant();
    updateBalanceUI(false);
    updateAnalysisNav();
    ["analysis-email", "support-email"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.textContent = state.email;
    });
    switchTab(state.activeTab || "home");
  }
}

// Ajusta o FAQ estático (aba Support) ao fluxo: documentos → aprovado → conta de recebimento.
function applyFaqVariant() {
  var q = document.getElementById("faq-q-docs");
  var a = document.getElementById("faq-a-docs");
  if (q) q.textContent = "What documents are needed for verification?";
  if (a) a.innerHTML = "You'll need to upload: (1) a valid government-issued ID; (2) a proof of address dated within the last 3 months; and (3) a selfie holding your ID. All documents must be clear, legible, and in color.";
  var qf = document.getElementById("faq-q-fail");
  if (qf) qf.textContent = "What happens after I'm approved?";
  var af = document.getElementById("faq-a-fail");
  if (af) af.innerHTML = "Once your verification is approved, you choose where to receive your <strong>$2,800.00</strong> — bank, PayPal, Cash App, Venmo or Zelle. The money is then delivered to your account within <strong>4 to 6 business days</strong>.";
  var aTime = document.getElementById("faq-a-time");
  if (aTime) aTime.innerHTML = "The verification takes 2–7 business days from the moment your documents are submitted. After you're approved and add your payout account, the money arrives in <strong>4 to 6 business days</strong>. Track it all in the <strong>Analysis</strong> tab.";
}

function updateAnalysisNav() {
  var bn = document.getElementById("bn-analysis");
  if (!bn) return;
  bn.classList.remove("disabled");
  if (state.analysisStart) {
    bn.setAttribute("data-tab", "analysis");
    bn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg><span>Analysis</span>';
  } else {
    bn.setAttribute("data-tab", "upload");
    bn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Verification</span>';
  }
}

// ===== HOME TAB =====

function renderHome() {
  var emailEl = document.getElementById("home-email");
  if (emailEl) emailEl.textContent = state.email;

  var hasStarted = state.analysisStart;
  var manual = !!state.manualReview;
  var day = hasStarted ? (manual ? getManualDay() : getCurrentDay()) : 0;
  var showApproved = !manual && day >= 7; // dia 7: análise APROVADA — pedir a conta de recebimento

  // Primary button
  var btn = document.getElementById("btn-primary-action");
  if (showApproved) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Get my $2,800.00';
    btn.onclick = function () { openUploadModal(); };
  } else if (hasStarted) {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> View Analysis Status';
    btn.onclick = function () { switchTab("analysis"); };
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Send documents';
    btn.onclick = function () { openUploadModal(); };
  }

  // Badge
  var badge = document.getElementById("home-badge");
  if (badge) {
    if (manual) {
      badge.textContent = "Payment · Day " + day + " of 6";
      badge.className = "hs-badge in-progress";
    } else if (showApproved) {
      badge.textContent = "Approved";
      badge.className = "hs-badge in-progress";
    } else if (hasStarted) {
      badge.textContent = "Day " + day + " of 7";
      badge.className = "hs-badge in-progress";
    } else {
      badge.textContent = "Pending";
      badge.className = "hs-badge pending";
    }
  }

  // Card title & desc
  var ct = document.getElementById("home-card-title");
  var cd = document.getElementById("home-card-desc");
  if (ct && cd) {
    if (manual) {
      ct.textContent = "Payment on the way";
      cd.textContent = "Your $2,800.00 is on its way to your payout account — arriving in 4 to 6 business days. Track it in the Analysis tab.";
    } else if (showApproved) {
      ct.textContent = "You're approved! 🎉";
      cd.textContent = "Your verification was approved. Choose where to receive your $2,800.00 — it arrives in 4 to 6 business days.";
    } else if (hasStarted) {
      ct.textContent = "Analysis in progress";
      cd.textContent = "Your documents are being verified. Follow the progress in the Analysis tab.";
    } else {
      ct.textContent = "Documents required";
      cd.textContent = "Send your documents to start the 7-day verification and release your balance.";
    }
  }

  // Alert banner
  var banner = document.getElementById("alert-banner");
  var icon = document.getElementById("alert-icon");
  var title = document.getElementById("alert-title");
  var desc = document.getElementById("alert-desc");
  var bcLabel = document.getElementById("home-bc-label");
  var bcDot = document.getElementById("home-bc-dot");

  if (banner && icon && title && desc) {
    if (manual) {
      banner.className = "alert-banner info";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>';
      title.textContent = "Payment on the way";
      desc.textContent = "Your $2,800.00 is being sent to your payout account — arriving in 4 to 6 business days. Track it in the Analysis tab.";
      if (bcDot) bcDot.style.background = "#16c784";
      if (bcLabel) bcLabel.textContent = "Payment sent";
      banner.style.display = "flex";
    } else if (showApproved) {
      banner.className = "alert-banner info";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#16c784" stroke-width="2.5"><circle cx="12" cy="12" r="10" fill="rgba(22,199,132,0.1)"/><polyline points="16 9 11 15 8 12"/></svg>';
      title.textContent = "Analysis approved 🎉";
      desc.textContent = "Great news — your verification was approved! Set up your payout account to receive your $2,800.00 in 4 to 6 business days.";
      if (bcDot) bcDot.style.background = "#16c784";
      if (bcLabel) bcLabel.textContent = "Approved";
      banner.style.display = "flex";
    } else if (hasStarted) {
      banner.className = "alert-banner info";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      title.textContent = "Analysis in progress";
      desc.textContent = "Your documents were received and the verification has started. You will receive the result within 7 days. Track the progress in the Analysis tab.";
      if (bcDot) bcDot.style.background = "#16c784";
      if (bcLabel) bcLabel.textContent = "Analysis in progress";
      banner.style.display = "flex";
    } else {
      banner.className = "alert-banner warning";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
      title.textContent = txt("Documentation required", "Payout account required");
      desc.textContent = txt("Send the required documents to start the analysis. Your withdrawal will be released within 7 days after verification.", "Set up your payout account to start the analysis. Your withdrawal will be released within 7 days after verification.");
      if (bcDot) bcDot.style.background = "rgba(255,255,255,0.4)";
      if (bcLabel) bcLabel.textContent = "Locked balance";
    }
  }

  updateAnalysisNav();
}

// ===== ANALYSIS TAB =====

function renderAnalysis() {
  var hasStarted = state.analysisStart;
  var deniedBlock = document.getElementById("analysis-denied");
  var scrollEl = document.getElementById("analysis-scroll");
  var progressEl = document.querySelector(".analysis-progress");
  var statusEl = document.getElementById("analysis-status");
  var timelineEl = document.querySelector(".analysis-timeline");

  if (!hasStarted) {
    if (deniedBlock) deniedBlock.style.display = "none";
    if (progressEl) progressEl.style.display = "none";
    if (statusEl) statusEl.style.display = "none";
    if (timelineEl) timelineEl.style.display = "none";
    return;
  }

  var manual = !!state.manualReview;
  var total = manual ? 6 : 7;
  var day = manual ? getManualDay() : getCurrentDay();
  var capped = Math.min(day, total);
  var showApproved = !manual && capped >= 7; // dia 7 da análise: APROVADO (mostra a tela de aprovação)
  var paymentDone = manual && capped >= 6;   // pagamento concluído (dia 6)
  var fillPercent = ((capped - 1) / (total - 1)) * 100;

  if (progressEl) progressEl.style.display = "block";
  if (statusEl) statusEl.style.display = "flex";
  if (timelineEl) timelineEl.style.display = "block";

  var dayEl = document.getElementById("ap-day");
  if (dayEl) dayEl.textContent = manual
    ? "Est. 4–6 days · Day " + capped + " of 6"
    : "Est. 2–7 days · Day " + capped;

  var fillEl = document.getElementById("ap-fill");
  if (fillEl) fillEl.style.width = Math.min(fillPercent, 100) + "%";

  var STEPS = manual ? getPayoutSteps() : getSteps();
  var step = STEPS[capped - 1] || STEPS[STEPS.length - 1];
  var statusText = document.getElementById("as-text");
  if (statusText) statusText.textContent = manual
    ? (paymentDone
        ? "Your payment was completed — the $2,800.00 is on its way to your payout account and arrives within 4 to 6 business days."
        : "Your $2,800.00 is being processed and sent to your payout account. It arrives within 4 to 6 business days — follow each step below.")
    : step.status;

  var statusIcon = document.getElementById("as-icon");
  if (statusIcon) {
    if (manual) {
      statusIcon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#16c784" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>';
    } else {
      statusIcon.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="#FE2C55" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    }
  }

  var list = document.getElementById("tl-list");
  if (list) {
    list.innerHTML = "";
    for (var i = 0; i < STEPS.length; i++) {
      var s = STEPS[i];
      var done = i < capped - 1 || (paymentDone && i === total - 1);
      var current = !done && i === capped - 1;
      var item = document.createElement("div");
      item.className = "tl-item";
      if (done) item.classList.add("completed");
      else if (current) item.classList.add("current");

      var iconWrap = document.createElement("div");
      iconWrap.className = "tl-i-icon";
      iconWrap.innerHTML = STEP_ICONS[i];
      item.appendChild(iconWrap);

      var content = document.createElement("div");
      content.className = "tl-i-content";

      var nameEl = document.createElement("span");
      nameEl.className = "tl-i-name";
      nameEl.textContent = s.label;
      content.appendChild(nameEl);

      var stEl = document.createElement("span");
      stEl.className = "tl-i-status";
      stEl.textContent = done ? "Completed" : (current ? s.status : "Pending");
      content.appendChild(stEl);

      var barWrap = document.createElement("div");
      barWrap.className = "tl-i-bar";
      var barFill = document.createElement("div");
      barFill.className = "tl-i-fill";
      if (done) barFill.style.width = "100%";
      else if (current) { barFill.classList.add("tl-i-fill--loading"); }
      else barFill.style.width = "0%";
      barWrap.appendChild(barFill);
      content.appendChild(barWrap);

      item.appendChild(content);

      if (done) {
        var statusBadge = document.createElement("div");
        statusBadge.className = "tl-i-approved";
        statusBadge.innerHTML = (manual ? 'Done' : 'Approved') + '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
        item.appendChild(statusBadge);
      } else if (current) {
        var badge = document.createElement("span");
        badge.className = "tl-i-badge";
        badge.textContent = manual ? "Processing..." : "Analyzing...";
        item.appendChild(badge);
      }

      list.appendChild(item);
      item.style.animationDelay = (0.06 * i) + "s";
    }
  }

  // Tela de APROVAÇÃO (dia 7 da análise) — reaproveita o bloco #analysis-denied.
  if (deniedBlock) {
    if (showApproved) {
      deniedBlock.style.display = "block";
      if (progressEl) progressEl.style.display = "none";
      if (timelineEl) timelineEl.style.display = "none";
      var statusCard = document.getElementById("analysis-status");
      if (statusCard) statusCard.style.display = "none";
      var adSub = document.querySelector(".ad-sub");
      if (adSub) adSub.innerHTML = "Great news — your verification <strong>passed</strong> and your <strong>$2,800.00</strong> is approved! Choose where you want to receive it and the money arrives in <strong>4 to 6 business days</strong>.";
      var adR1 = document.getElementById("ad-r1");
      if (adR1) adR1.textContent = "Pick how you want to get paid — PayPal, bank, Cash App, Venmo or Zelle";
      var adR2 = document.getElementById("ad-r2");
      if (adR2) adR2.textContent = "Your $2,800.00 is sent straight to your account — no documents needed";
      var resendBtn = document.getElementById("btn-resend-docs");
      if (resendBtn) { resendBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Choose where to receive my $2,800.00'; resendBtn.onclick = function () { openUploadModal(); }; }
    } else {
      deniedBlock.style.display = "none";
      // garante que o card de status volte a aparecer (fase pagamento / dias < 7)
      var statusCard2 = document.getElementById("analysis-status");
      if (statusCard2) statusCard2.style.display = "flex";
    }
  }
}

// ===== LOGIN =====

document.getElementById("login-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  var emailInput = document.getElementById("email");
  var msg = document.getElementById("form-msg");
  var btn = e.target.querySelector(".btn-primary");
  // normaliza igual ao servidor pra localStorage, UI e banco baterem
  var email = emailInput.value.trim().toLowerCase();
  var emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

  if (!emailRegex.test(email)) {
    setMsg(msg, "Enter a valid email.", "error");
    emailInput.focus();
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  setMsg(msg, "", "");

  try {
    state.email = email;
    // analysisStart is restored from localStorage by loadState() if it exists
    saveState();
    route();
    showToast("Access granted! Welcome.", "success");
    await syncWithServer("get"); // busca a data real no servidor (migra quem ja tinha comecado)
    route();
    maybeShowOffer();
  } catch (err) {
    setMsg(msg, "Connection error. Please try again.", "error");
  }
  btn.disabled = false;
  btn.innerHTML = "Sign in to TikTok";
});

function setMsg(el, text, type) {
  if (!el) return;
  el.textContent = text;
  el.className = "form-msg" + (type ? " " + type : "");
}

// ===== MODAL =====

// ===== FLUXO EM 2 FASES: DOCUMENTOS no início → APROVADO no dia 7 → CONTA DE RECEBIMENTO =====
// Fase 1: a pessoa envia os documentos e passa pela análise de 7 dias (cópia "documentos").
// Fase 2: no dia 7 a análise é APROVADA e aí sim pedimos a conta de recebimento (payout),
// com o dinheiro chegando em 4 a 6 dias. Por isso txt() sempre usa a versão documentos —
// a conta de recebimento tem cópia própria e o modal escolhe o formulário pela FASE.
function variantKey() { return "tk_variant" + (state.email ? ":" + state.email : ""); }
function txt(a, b) { return a; } // fase 1 = documentos (sempre)

// Fase em que a pessoa PODE informar a conta de recebimento: a análise fechou os 7 dias
// (aprovada) e ela ainda não enviou o payout. Antes disso, o modal pede documentos.
function payoutStage() {
  return !!state.analysisStart && !state.manualReview && getCurrentDay() >= 7;
}
function modalMode() { return payoutStage() ? "payout" : "docs"; }

function applyModalForm() {
  var mode = modalMode();
  var docs = document.getElementById("variant-docs");
  var payout = document.getElementById("variant-payout");
  var title = document.querySelector("#upload-modal .modal-title");
  var desc = document.getElementById("modal-desc");
  var submitBtn = document.getElementById("btn-submit-docs");
  if (!docs || !payout) return;
  if (mode === "docs") {
    docs.style.display = "block"; payout.style.display = "none";
    if (title) title.textContent = "Document Verification";
    if (desc) desc.innerHTML = "To release your <strong>$2,800.00</strong> balance, send the documents below for verification.";
    if (document.getElementById("pay-fields")) document.getElementById("pay-fields").innerHTML = "";
    if (submitBtn) submitBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Confirm &amp; Start Analysis';
  } else {
    docs.style.display = "none"; payout.style.display = "block";
    if (title) title.textContent = "Payout Account";
    if (desc) desc.innerHTML = "You're <strong>approved</strong>! 🎉 Choose where to receive your <strong>$2,800.00</strong> — it arrives in <strong>4 to 6 business days</strong>.";
    if (typeof renderPayFields === "function") renderPayFields();
    if (submitBtn) submitBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Confirm payout account';
  }
}

function openUploadModal() {
  applyModalForm();
  document.getElementById("upload-modal").classList.add("open");
}

function closeUploadModal() {
  if (document.getElementById("upload-success").classList.contains("show")) return;
  document.getElementById("upload-modal").classList.remove("open");
}

// Tela de espera pós-envio: acende os passos um a um e enche a barra,
// depois chama done() pra revelar a analise. Puramente visual.
function runProcessing(done) {
  var scr = document.getElementById("processing-screen");
  var fill = document.getElementById("ps-bar-fill");
  var steps = Array.prototype.slice.call(document.querySelectorAll("#ps-steps .ps-step"));
  var STEP_MS = 1200;

  // tela de espera do PAGAMENTO (só roda ao enviar a conta de recebimento, no dia 7 aprovado)
  var psTitle = document.querySelector(".ps-title");
  if (psTitle) psTitle.textContent = "Processing your payout";
  var psSub = document.querySelector(".ps-sub");
  if (psSub) psSub.textContent = "Please wait — we're setting up your transfer.";
  var stepTxts = document.querySelectorAll("#ps-steps .ps-step-txt");
  if (stepTxts[0]) stepTxts[0].textContent = "Payout account received";
  if (stepTxts[1]) stepTxts[1].textContent = "Confirming your details";
  if (stepTxts[2]) stepTxts[2].textContent = "Approving the transfer";
  if (stepTxts[3]) stepTxts[3].textContent = "Scheduling your payment";

  steps.forEach(function (s) { s.classList.remove("active", "loading"); });
  fill.style.width = "0%";
  scr.classList.add("show");

  function focus(i) {
    for (var k = 0; k < steps.length; k++) {
      steps[k].classList.remove("loading");
      if (k < i) steps[k].classList.add("active");
    }
    if (i < steps.length) steps[i].classList.add("loading");
    fill.style.width = Math.min(100, 15 + (i / steps.length) * 85) + "%";
  }

  var i = 0;
  setTimeout(function () { focus(0); }, 120);
  var timer = setInterval(function () {
    i++;
    if (i < steps.length) {
      focus(i);
    } else {
      clearInterval(timer);
      steps.forEach(function (s) { s.classList.remove("loading"); s.classList.add("active"); });
      fill.style.width = "100%";
      setTimeout(function () {
        scr.classList.remove("show");
        if (done) done();
      }, 850);
    }
  }, STEP_MS);
}

document.getElementById("btn-close-modal").addEventListener("click", closeUploadModal);
document.getElementById("upload-modal").addEventListener("click", function (e) {
  if (e.target === this) closeUploadModal();
});

// ===== UPLOAD =====

// ===== CONTA DE RECEBIMENTO (payout) — substitui o envio de documentos =====
// Cada método pede só o essencial pra "receber" — fricção baixa (não pede banco pra
// quem escolhe PayPal/Cash App, etc). Os dados NÃO são enviados/salvos (igual eram os
// documentos fake): só o email conta a análise no servidor.
var PAY_METHODS = {
  bank:    { fields: [ { key: "holder", label: "Account holder name", ph: "John Smith", type: "text" }, { key: "routing", label: "Routing number", ph: "9 digits", type: "tel", max: 9 }, { key: "account", label: "Account number", ph: "Your account number", type: "tel", max: 17 } ] },
  paypal:  { fields: [ { key: "email", label: "PayPal email", ph: "you@email.com", type: "email" } ] },
  cashapp: { fields: [ { key: "tag", label: "$Cashtag", ph: "$yourcashtag", type: "text" } ] },
  venmo:   { fields: [ { key: "user", label: "Venmo username", ph: "@your-venmo", type: "text" } ] },
  zelle:   { fields: [ { key: "id", label: "Zelle email or phone", ph: "Email or phone number", type: "text" } ] },
};
var selectedMethod = "bank";

function renderPayFields() {
  var box = document.getElementById("pay-fields");
  if (!box) return;
  var m = PAY_METHODS[selectedMethod];
  box.innerHTML = m.fields.map(function (f) {
    return '<div class="pf"><label>' + f.label + '</label>' +
      '<input class="pf-input" data-key="' + f.key + '" type="' + f.type + '" placeholder="' + f.ph + '"' + (f.max ? ' maxlength="' + f.max + '"' : '') + ' autocomplete="off" /></div>';
  }).join("");
}
function selectMethod(method) {
  selectedMethod = method;
  var btns = document.querySelectorAll("#pay-methods .pm");
  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-method") === method);
  renderPayFields();
}
(function () {
  var pms = document.querySelectorAll("#pay-methods .pm");
  for (var i = 0; i < pms.length; i++) {
    pms[i].addEventListener("click", function () { selectMethod(this.getAttribute("data-method")); });
  }
  selectMethod("bank");
  // feedback visual dos uploads (variante A): marca o check verde quando escolhe o arquivo
  var docsBox = document.getElementById("variant-docs");
  if (docsBox) {
    docsBox.addEventListener("change", function (e) {
      var inp = e.target;
      if (!inp.classList || !inp.classList.contains("uz-input")) return;
      var zone = inp.closest(".upload-zone");
      var statusEl = zone ? zone.querySelector(".uz-status") : null;
      if (inp.files && inp.files.length > 0) {
        if (zone) zone.classList.add("has-file");
        if (statusEl) statusEl.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#16c784" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    });
  }
})();

document.getElementById("doc-form").addEventListener("submit", async function (e) {
  e.preventDefault();
  var msg = document.getElementById("upload-msg");
  var btn = document.getElementById("btn-submit-docs");
  var mode = modalMode(); // "docs" na fase 1 (início) · "payout" no dia 7 (aprovado)
  var allFilled = true;

  if (mode === "docs") {
    // FASE 1: valida os 3 documentos (arquivos)
    var fileIn = document.querySelectorAll("#variant-docs .uz-input");
    allFilled = fileIn.length > 0;
    for (var i = 0; i < fileIn.length; i++) {
      var zone = fileIn[i].closest(".upload-zone");
      if (!fileIn[i].files || fileIn[i].files.length === 0) { allFilled = false; if (zone) { zone.style.borderColor = "#FE2C55"; zone.style.background = "rgba(254,44,85,.04)"; } }
      else if (zone) { zone.style.borderColor = ""; zone.style.background = ""; }
    }
    if (!allFilled) { setMsg(msg, "Select all required documents.", "error"); showToast("Fill in all fields.", "error"); return; }
  } else {
    // FASE 2 (aprovado): valida os campos da conta de recebimento
    var payInputs = document.querySelectorAll("#pay-fields .pf-input");
    allFilled = payInputs.length > 0;
    for (var j = 0; j < payInputs.length; j++) {
      if (!payInputs[j].value.trim()) { allFilled = false; payInputs[j].style.borderColor = "#FE2C55"; }
      else payInputs[j].style.borderColor = "";
    }
    if (!allFilled) { setMsg(msg, "Fill in your payout details.", "error"); showToast("Fill in all fields.", "error"); return; }
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Submitting...';
  setMsg(msg, "", "");

  try {
    var alreadyStarted = !!state.analysisStart;
    // FASE 2: enviar a conta de recebimento (no dia 7, já aprovado) inicia o PAGAMENTO.
    var enteringPayment = mode === "payout";
    if (enteringPayment) { state.manualReview = true; state.manualStart = Date.now(); } // otimista; o servidor confirma
    if (!state.analysisStart) state.analysisStart = Date.now();
    // "resend" grava manual_started_at (início do pagamento) no servidor; "start" grava
    // started_at (início da análise). Os dois voltam com o estado autoritativo, pra seguir
    // a pessoa pelo email em qualquer navegador.
    await syncWithServer(enteringPayment ? "resend" : "start");
    var data = { analysisStart: state.analysisStart, alreadyStarted: alreadyStarted };

    if (data.analysisStart) {
      state.analysisStart = data.analysisStart;
      saveState();

      var isPayment = enteringPayment; // enviou a conta de recebimento => tela de espera do pagamento

      // play plim sound
      try {
        var actx = new (window.AudioContext || window.webkitAudioContext)();
        var osc = actx.createOscillator();
        var gain = actx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, actx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.6);
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.start();
        osc.stop(actx.currentTime + 0.6);
      } catch (e) {}

      var formEl = document.getElementById("doc-form");
      var restoreBtn = function () {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Confirm &amp; Start Analysis';
      };

      renderHome();
      renderAnalysis();
      renderEarn(); // desbloqueia a aba Earn assim que envia os documentos
      updateAnalysisNav();

      if (isPayment) {
        // ===== FASE 2 (aprovado): tela de espera completa "Processing your payout" =====
        formEl.style.display = "";
        document.getElementById("upload-modal").classList.remove("open");
        restoreBtn();
        runProcessing(function () {
          switchTab("analysis");
          showToast("Payout account confirmed! Your payment is on the way.", "success");
        });
      } else {
        // ===== FASE 1: check rapido dentro do modal (comportamento original) =====
        var successEl = document.getElementById("upload-success");
        formEl.style.display = "none";
        successEl.classList.add("show");
        setTimeout(function () {
          successEl.classList.remove("show");
          formEl.style.display = "";
          document.getElementById("upload-modal").classList.remove("open");
          restoreBtn();
          if (data.alreadyStarted) {
            showToast("Analysis already in progress.", "");
          } else {
            showToast(txt("Documents sent!", "Account submitted!") + " " + txt("Analysis", "Verification") + " started.", "success");
          }
          renderHome();
          renderAnalysis();
          updateAnalysisNav();
          switchTab("analysis");
        }, 1500);
      }
      return;
    } else {
      setMsg(msg, data.error || "Error submitting account.", "error");
      showToast("Error sending. Please try again.", "error");
    }
  } catch (err) {
    setMsg(msg, "Connection error. Please try again.", "error");
    showToast("Connection error.", "error");
  }
  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg> Confirm &amp; Start Analysis';
});

// ===== FAQ ACCORDION =====

document.querySelectorAll(".faq-q").forEach(function (btn) {
  btn.addEventListener("click", function () {
    var item = btn.closest(".faq-item");
    var open = item.classList.contains("open");
    document.querySelectorAll(".faq-item.open").forEach(function (el) { el.classList.remove("open"); });
    if (!open) item.classList.add("open");
  });
});

// ===== BOTTOM NAV =====

document.getElementById("bottom-nav").addEventListener("click", function (e) {
  var item = e.target.closest(".bn-item");
  if (!item || item.classList.contains("disabled")) return;
  var tab = item.getAttribute("data-tab");
  if (tab) {
    if (tab === "analysis") renderAnalysis();
    if (tab === "earn") renderEarn();
    if (tab === "upload") { openUploadModal(); return; }
    switchTab(tab);
  }
});

// ===== NOTIFICATIONS =====

document.getElementById("btn-notif").addEventListener("click", function () {
  showToast("No new notifications.", "");
});

// ===== VISIBILITY =====

document.addEventListener("visibilitychange", function () {
  if (!document.hidden && state.analysisStart) {
    if (document.getElementById("tab-analysis").classList.contains("active")) {
      renderAnalysis();
    }
  }
});

// ===== OFERTAS (EDITE AQUI) =====
// A oferta aparece SO nos dias definidos em OFFER_DAYS (hoje: 5, 6 e 7).
// Pra mudar quais dias disparam, edite OFFER_DAYS abaixo (ex: [5] = so no dia 5).
//
// Cada dia tem sua oferta em OFFERS_BY_DAY. Campos:
//  - badge:    selo em cima (ex: "Day 5 - Final offer")
//  - title:    titulo da oferta
//  - desc:     descricao curta
//  - oldPrice: preco antigo riscado (deixe "" pra esconder)
//  - price:    preco atual em destaque (deixe "" pra esconder a linha de preco toda)
//  - cta:      texto do botao
//  - url:      LINK DO CHECKOUT — troque "#" pelo seu link (ex: "https://seu-checkout.com")
// DESATIVADO temporariamente (pedido do Yalo): pop-up de oferta descontinuado por enquanto.
// Pra reativar depois, volte pra [5, 6, 7] (ou os dias que quiser). A config das ofertas
// abaixo em OFFERS_BY_DAY continua intacta e pronta pra usar.
var OFFER_DAYS = [];

var OFFERS_BY_DAY = {
  5: { badge: "Day 5 - Special offer", title: "Offer for day 5 (edit this)", desc: "Replace with your day-5 offer. Edit the text, price and link in app.js.", oldPrice: "$97", price: "$47", cta: "Get access now", url: "#" },
  6: { badge: "Day 6 - Reminder",      title: "Offer for day 6 (edit this)", desc: "Replace with your day-6 offer. Edit the text, price and link in app.js.", oldPrice: "$97", price: "$47", cta: "Get access now", url: "#" },
  7: { badge: "Day 7 - Last call",     title: "Offer for day 7 (edit this)", desc: "Replace with your day-7 offer. Edit the text, price and link in app.js.", oldPrice: "$97", price: "$47", cta: "Get access now", url: "#" },
};

// true  = o popup aparece 1x por dia (nao enche o saco de quem ja viu)
// false = aparece toda vez que o cliente abre o app
var OFFER_ONCE_PER_DAY = true;

// Dia atual autoritativo (getCurrentDay ja prioriza o servidor).
function offerDay() {
  return getCurrentDay();
}

// Dias de oferta ja exibidos, guardados como lista (nao so o ultimo).
function offerSeenDays() {
  try { return JSON.parse(localStorage.getItem("tk_offerSeenDays") || "[]") || []; }
  catch (e) { return []; }
}
function addOfferSeenDay(d) {
  try {
    var s = offerSeenDays();
    if (s.indexOf(d) === -1) { s.push(d); localStorage.setItem("tk_offerSeenDays", JSON.stringify(s)); }
  } catch (e) {}
}

// Qual oferta exibir: o MAIOR dia de OFFER_DAYS que ja chegou e ainda nao foi visto.
// Assim, se o cliente nao abrir o app num dia, ele nao "perde" a oferta — ve a mais recente.
function offerToShow() {
  var day = offerDay();
  if (!day) return 0;
  var seen = OFFER_ONCE_PER_DAY ? offerSeenDays() : [];
  var pick = 0;
  for (var i = 0; i < OFFER_DAYS.length; i++) {
    var d = OFFER_DAYS[i];
    if (d <= day && seen.indexOf(d) === -1 && d > pick) pick = d;
  }
  return pick;
}

function renderOffer(o) {
  function byId(id) { return document.getElementById(id); }
  byId("offer-badge").textContent = o.badge || "Today only";
  byId("offer-title").textContent = o.title || "";
  byId("offer-desc").textContent = o.desc || "";

  var priceWrap = byId("offer-price");
  if (o.price) {
    priceWrap.classList.remove("hidden");
    byId("offer-price-now").textContent = o.price;
    var oldEl = byId("offer-price-old");
    if (o.oldPrice) { oldEl.style.display = ""; oldEl.textContent = o.oldPrice; }
    else oldEl.style.display = "none";
  } else {
    priceWrap.classList.add("hidden");
  }

  var cta = byId("offer-cta");
  cta.textContent = o.cta || "Get access now";
  if (o.url && o.url !== "#") cta.href = o.url;
  else cta.removeAttribute("href");
}

function maybeShowOffer() {
  if (!state.email) return;
  var day = offerToShow();
  if (!day) return; // nenhum dia de oferta elegivel/nao-visto ainda

  var offer = OFFERS_BY_DAY[day];
  if (!offer) return;

  state._shownOfferDay = day; // guarda o dia REALMENTE exibido pra marcar certo depois
  renderOffer(offer);
  setTimeout(function () {
    document.getElementById("offer-modal").classList.add("open");
  }, 700);
}

function markOfferSeen() {
  if (state._shownOfferDay) addOfferSeenDay(state._shownOfferDay);
}

function closeOffer() {
  document.getElementById("offer-modal").classList.remove("open");
  markOfferSeen();
}

document.getElementById("offer-close").addEventListener("click", closeOffer);
document.getElementById("offer-dismiss").addEventListener("click", closeOffer);
document.getElementById("offer-modal").addEventListener("click", function (e) {
  if (e.target === this) closeOffer();
});
document.getElementById("offer-cta").addEventListener("click", function () {
  markOfferSeen();
  setTimeout(function () {
    document.getElementById("offer-modal").classList.remove("open");
  }, 200);
});

// ===== BOOT =====
// (o boot ficava aqui, mas foi movido para o FINAL do arquivo — precisa rodar
//  depois de TODAS as definições, senão o route() chama funções/consts do Earn
//  que ainda não existem e quebra a renderização.)

// ================================================================
// SUPPORT ASSISTANT — chat automático (respostas prontas, sem atendente real)
// Modelado no assistente do entregaveltik. Não envia nada pra ninguém;
// tudo roda no navegador e o histórico fica no localStorage por email.
// ================================================================
(function () {
  var REWARD = "$2,800.00";
  var DAYS_FIRST = 7, DAYS_PAY = 6;

  // Momento atual da cliente no funil — as perguntas e respostas se adaptam a ele.
  //  new      = ainda não enviou documentos
  //  progress = análise em andamento (dia < 7)
  //  failed   = análise APROVADA (dia 7) — precisa informar a conta de recebimento
  //  manual   = pagamento em andamento (chega em 4 a 6 dias)
  function ctx() {
    if (!state.analysisStart) return { phase: "new", day: 0 };
    var manual = !!state.manualReview;
    var day = manual ? getManualDay() : getCurrentDay();
    if (manual) return { phase: "manual", day: Math.min(day, DAYS_PAY) };
    if (day >= 7) return { phase: "failed", day: 7 };
    return { phase: "progress", day: Math.min(day, DAYS_FIRST) };
  }

  var A_DOCS = txt("You need three items: <strong>ID document</strong> (passport or driver's license), a <strong>selfie holding your ID</strong>, and a recent <strong>proof of residence</strong> (utility or phone bill).", "Just add where you want to receive your money: a <strong>bank account</strong>, <strong>PayPal</strong>, <strong>Cash App</strong>, <strong>Venmo</strong> or <strong>Zelle</strong>. No documents needed.");
  var A_SAFE = "Yes. The " + txt("document review", "account review") + " follows the official verification policy and no third party has access to your data. Everything stays encrypted.";
  var A_LOCKED = "To protect your account, the <strong>" + REWARD + "</strong> balance stays locked until the official team " + txt("validates your documents", "verifies your payout account") + ". Once approved, Send, Receive and Withdraw are unlocked automatically.";
  var FALLBACK = "I'm the automated assistant and I can help with validation time, " + txt("required documents", "your payout account") + ", locked balance and withdrawals. For anything else, the team handles your case directly during the analysis.";

  // Cada tópico: q (texto do botão) · keys (match ao digitar) · a (string ou função(c)).
  var TOPICS = {
    unlock: { q: "How do I unlock my balance?", keys: ["unlock", "release", "how do i start", "get started", "liberar", "como libero"],
      a: "Send your <strong>ID</strong>, <strong>selfie with ID</strong> and <strong>proof of residence</strong> to start the official verification. Once approved — within 2 to " + DAYS_FIRST + " business days — you choose where to receive your " + REWARD + "." },
    time: { q: "How long does it take?", keys: ["how long", "long", "time", "day", "days", "take", "demora", "tempo", "prazo", "quando", "when"],
      a: "The team verifies your documents within <strong>2 to " + DAYS_FIRST + " business days</strong>. Once you're approved and add your payout account, the money arrives in <strong>4 to " + DAYS_PAY + " business days</strong>." },
    locked: { q: "Why is my balance locked?", keys: ["lock", "locked", "balance", "block", "held", "saldo", "travad", "bloquead"], a: A_LOCKED },
    docs: { q: "Which documents do I need?", keys: ["document", "documents", "need", "which", "upload", "quais", "doc", "photo", "id", "selfie", "proof"], a: A_DOCS },
    withdraw: { q: "Can I withdraw before approval?", keys: ["withdraw", "before", "skip", "saque", "antes", "transfer", "cash", "early"],
      a: "No. Withdrawals unlock <strong>after</strong> the official team approves your documents. Then you add your payout account and receive your " + REWARD + " in 4 to " + DAYS_PAY + " business days." },
    safe: { q: "Is this process safe?", keys: ["safe", "secure", "security", "scam", "fraud", "seguro", "segur", "trust", "privacy", "legit", "golpe"], a: A_SAFE },
    statusP: { q: "What's the status of my analysis?", keys: ["status", "progress", "where", "stage", "andamento", "situacao", "update"],
      a: function (c) { return "Your documents are being verified by the official team. You're on <strong>day " + c.day + " of " + DAYS_FIRST + "</strong> — follow each step live on the <strong>Analysis</strong> tab."; } },
    // --- momento: APROVADO (dia 7), precisa informar a conta de recebimento ---
    approved: { q: "I got approved — what now?", keys: ["approved", "approve", "aprovad", "passed", "now what", "what now", "next", "get paid"],
      a: "Congrats — you're <strong>approved</strong>! 🎉 Open the <strong>Analysis</strong> tab and tap <strong>“Choose where to receive my " + REWARD + "”</strong>. Add your PayPal, bank, Cash App, Venmo or Zelle and the money arrives in <strong>4 to " + DAYS_PAY + " business days</strong>." },
    payoutOptions: { q: "How can I receive the money?", keys: ["paypal", "cash app", "venmo", "zelle", "bank", "payout", "method", "how can i receive", "how do i get paid", "receber", "pix", "account"],
      a: "You can get paid via <strong>bank account</strong>, <strong>PayPal</strong>, <strong>Cash App</strong>, <strong>Venmo</strong> or <strong>Zelle</strong>. Just add the details where you want to receive your " + REWARD + " — no extra documents needed." },
    payTime: { q: "How long until the money arrives?", keys: ["arrive", "how long", "receive", "prazo", "quando chega", "days", "when"],
      a: "After you add your payout account, your " + REWARD + " is delivered within <strong>4 to " + DAYS_PAY + " business days</strong>. You can track it live on the <strong>Analysis</strong> tab." },
    // --- momento: PAGAMENTO em andamento (manual) ---
    statusM: { q: "What's the status of my payment?", keys: ["status", "progress", "where", "stage", "andamento", "situacao", "update", "payment", "pagamento"],
      a: function (c) { return "Your " + REWARD + " is on its way to your payout account — you're on <strong>day " + c.day + " of " + DAYS_PAY + "</strong>. Follow it live on the <strong>Analysis</strong> tab."; } },
    payArrive: { q: "When will the money arrive?", keys: ["when", "arrive", "how long", "receive", "prazo", "quando", "chega"],
      a: "Your payment is being processed and arrives within <strong>4 to " + DAYS_PAY + " business days</strong> from when you added your payout account. It's already on the way." },
    payWrong: { q: "I entered the wrong payout details", keys: ["wrong", "mistake", "change", "update", "errad", "corrigir", "editar", "fix"],
      a: "No worries — if there's any issue with the payout details, the transfer bounces back safely and you'll be able to re-enter them. Your " + REWARD + " is never lost." }
  };

  // Quais tópicos aparecem (e em que ordem) em cada momento.
  var PHASE = {
    new: ["unlock", "docs", "time", "locked", "safe"],
    progress: ["statusP", "time", "locked", "withdraw", "docs", "safe"],
    failed: ["approved", "payoutOptions", "payTime", "safe"],
    manual: ["statusM", "payArrive", "payoutOptions", "payWrong", "safe"]
  };

  // Saudação inicial, também de acordo com o momento.
  var WELCOME = {
    new: "Hi! 👋 I'm the automated support assistant. I can help you unlock your balance — ask about the documents, the validation time or safety.",
    progress: "Hi! 👋 Your documents are under review by the official team. I can explain the validation time, your current status, or how the process works.",
    failed: "Hi! 👋 Great news — your verification was <strong>approved</strong>! 🎉 I can explain how to choose where to receive your " + REWARD + " and when it arrives.",
    manual: "Hi! 👋 Your payment is on the way! I can explain the timeline, how you'll receive it and when the money lands."
  };

  // Respostas por intenção quando digita algo fora dos tópicos.
  var CUSTOM = [
    { words: ["human", "person", "agent", "attendant", "representative", "contact", "speak", "call", "email", "phone", "whatsapp"], a: FALLBACK },
    { words: ["hi ", "hello", "hey", " ola ", " oi ", "good morning", "good afternoon", "good evening", "yo "], a: function (c) { return WELCOME[c.phase] || WELCOME.progress; } },
    { words: ["thanks", "thank", "obrigad", "valeu", "vlw", "okay", "great", "perfect", "got it", "cool", "nice"], a: "You're welcome! 😊 If anything else comes up about your " + txt("documents", "account") + " or balance, just ask." }
  ];

  var box = document.getElementById("support-chat");
  var bodyEl = document.getElementById("chat-body");
  if (!box || !bodyEl) return; // aba de suporte não presente

  function resolveA(a, c) { return typeof a === "function" ? a(c) : a; }

  function chatKey() { return "tk_chat_history" + (state.email ? ":" + state.email : ""); }
  function loadHist() { try { var a = JSON.parse(localStorage.getItem(chatKey()) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function saveHist(l) { try { localStorage.setItem(chatKey(), JSON.stringify(l.slice(-60))); } catch (e) {} }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  function bubble(role, html) { var b = document.createElement("div"); b.className = "chat-msg " + role; b.innerHTML = html; return b; }
  function feedbackBar() {
    var bar = document.createElement("div"); bar.className = "chat-fb";
    bar.innerHTML = "<span>Was this helpful?</span>";
    var up = document.createElement("button"); up.type = "button"; up.textContent = "👍";
    var down = document.createElement("button"); down.type = "button"; down.textContent = "👎";
    bar.appendChild(up); bar.appendChild(down);
    function done(t) { bar.innerHTML = '<span class="fb-note">' + t + "</span>"; }
    up.onclick = function () { done("Thanks for the feedback! 🙌"); };
    down.onclick = function () { done("Sorry about that — try rephrasing your question."); };
    return bar;
  }
  function render(role, html, fb) {
    bodyEl.appendChild(bubble(role, html));
    if (role === "bot" && fb) bodyEl.appendChild(feedbackBar());
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function append(role, html) { render(role, html, role === "bot"); var l = loadHist(); l.push({ role: role, html: html }); saveHist(l); }

  var typingEl = null;
  function typing(on) {
    if (on) { if (typingEl) return; typingEl = document.createElement("div"); typingEl.className = "chat-typing"; typingEl.innerHTML = "<span></span><span></span><span></span>"; bodyEl.appendChild(typingEl); bodyEl.scrollTop = bodyEl.scrollHeight; }
    else if (typingEl) { typingEl.remove(); typingEl = null; }
  }
  function botReply(html) { typing(true); setTimeout(function () { typing(false); append("bot", html); }, 850); }

  function answerFor(text) {
    var c = ctx();
    var t = " " + text.toLowerCase() + " ";

    // Furo evitado: se pergunta sobre rejeição mas NÃO está no momento de falha/revisão,
    // não inventa motivo — explica o estado real.
    if (/(reject|denied|recus|negad|refused|not approved|inelig)/.test(t)) {
      if (c.phase === "new") return "Nothing was rejected — you haven't submitted anything yet. Send your ID, selfie and proof of residence to start the verification.";
      if (c.phase === "failed" || c.phase === "manual") return "You weren't rejected — you were <strong>approved</strong>! 🎉 Your " + REWARD + " is on its way to your payout account, arriving in 4 to " + DAYS_PAY + " business days.";
      return "Your documents haven't been rejected — still under verification (<strong>day " + c.day + " of " + DAYS_FIRST + "</strong>). You'll see the result on the <strong>Analysis</strong> tab.";
    }

    // pontua os tópicos do momento atual primeiro; se nada bater, tenta todos
    var best = null, bestScore = 0;
    function scoreOver(ids) {
      for (var i = 0; i < ids.length; i++) {
        var tp = TOPICS[ids[i]]; if (!tp) continue;
        var sc = 0; for (var k = 0; k < tp.keys.length; k++) if (t.indexOf(tp.keys[k]) !== -1) sc++;
        if (sc > bestScore) { bestScore = sc; best = tp; }
      }
    }
    scoreOver(PHASE[c.phase] || []);
    if (!best) scoreOver(Object.keys(TOPICS));
    if (best) return resolveA(best.a, c);

    for (var x = 0; x < CUSTOM.length; x++) for (var j = 0; j < CUSTOM[x].words.length; j++) if (t.indexOf(CUSTOM[x].words[j]) !== -1) return resolveA(CUSTOM[x].a, c);
    return FALLBACK;
  }

  function renderQuick(c) {
    var q = document.getElementById("chat-quick"); q.innerHTML = "";
    (PHASE[c.phase] || PHASE.progress).forEach(function (idT) {
      var tp = TOPICS[idT]; if (!tp) return;
      var b = document.createElement("button"); b.type = "button"; b.textContent = tp.q;
      b.onclick = function () { append("user", escapeHtml(tp.q)); botReply(resolveA(tp.a, ctx())); };
      q.appendChild(b);
    });
  }
  function phaseKey() { return "tk_chat_phase" + (state.email ? ":" + state.email : ""); }
  function openChat() {
    var c = ctx();
    var savedPhase = null; try { savedPhase = localStorage.getItem(phaseKey()); } catch (e) {}
    var hist = loadHist();
    // conversa nova, ou o momento dela mudou desde a última visita -> recomeça com a saudação certa
    if (!hist.length || savedPhase !== c.phase) {
      hist = [{ role: "bot", html: WELCOME[c.phase] || WELCOME.progress }];
      saveHist(hist);
      try { localStorage.setItem(phaseKey(), c.phase); } catch (e) {}
    }
    bodyEl.innerHTML = "";
    for (var i = 0; i < hist.length; i++) render(hist[i].role, hist[i].html, hist[i].role === "bot");
    renderQuick(c);
    box.classList.add("open");
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }
  function closeChat() { box.classList.remove("open"); }
  function clearChat() {
    var c = ctx();
    var w = WELCOME[c.phase] || WELCOME.progress;
    saveHist([{ role: "bot", html: w }]);
    bodyEl.innerHTML = "";
    render("bot", w, true);
    renderQuick(c);
  }

  var openBtn = document.getElementById("btn-open-chat");
  if (openBtn) openBtn.addEventListener("click", openChat);
  document.getElementById("chat-close").addEventListener("click", closeChat);
  document.getElementById("chat-clear").addEventListener("click", clearChat);
  box.addEventListener("click", function (e) { if (e.target === box) closeChat(); });
  document.getElementById("chat-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var inp = document.getElementById("chat-text"); var v = (inp.value || "").trim(); if (!v) return;
    inp.value = ""; append("user", escapeHtml(v)); botReply(answerFor(v));
  });
})();

// ================================================================
// EARN — assistir vídeos e ganhar (só libera após enviar documentos)
// Config fácil de mexer: valor por vídeo, limite diário, saldo base.
// ================================================================
var EARN_PER_VIDEO = 7;         // $ por vídeo assistido
var EARN_MAX_PER_DAY = 15;      // vídeos liberados por dia
var EARN_BASE_BALANCE = 2800;   // saldo travado inicial
var EARN_MIN_WATCH_S = 12;      // segundos mínimos no TikTok pra o vídeo contar

// VÍDEOS DO TIKTOK (reais, dos EUA) — a pessoa vai assistir e volta pra resgatar.
// Cada item: url (link do vídeo), thumb (capa real hospedada no Supabase), handle (@ do criador).
// Pra trocar os vídeos depois, é só editar esta lista.
var TK_THUMB_BASE = "https://eikttymgijupiwovfsob.supabase.co/storage/v1/object/public/earn-thumbs/";
var TIKTOK_VIDEOS = [
  { url: "https://www.tiktok.com/@dreanaylor/video/7094090119195446570", thumb: TK_THUMB_BASE + "t000.jpg", handle: "@dreanaylor", pay: 5.81 },
  { url: "https://www.tiktok.com/@happyhome_withsara79/video/7094322616432954670", thumb: TK_THUMB_BASE + "t001.jpg", handle: "@happyhome_withsara79", pay: 6.54 },
  { url: "https://www.tiktok.com/@jixiewang/video/7099673155060452654", thumb: TK_THUMB_BASE + "t002.jpg", handle: "@jixiewang", pay: 7.27 },
  { url: "https://www.tiktok.com/@plantdaddypodcast/video/7096152766636297518", thumb: TK_THUMB_BASE + "t003.jpg", handle: "@plantdaddypodcast", pay: 8.00 },
  { url: "https://www.tiktok.com/@kaelimaee/video/7100978550509014314", thumb: TK_THUMB_BASE + "t004.jpg", handle: "@kaelimaee", pay: 8.73 },
  { url: "https://www.tiktok.com/@yxdesignstudio/video/7095651273697004843", thumb: TK_THUMB_BASE + "t005.jpg", handle: "@yxdesignstudio", pay: 9.46 },
  { url: "https://www.tiktok.com/@thegibbyhome/video/7096585198334233898", thumb: TK_THUMB_BASE + "t006.jpg", handle: "@thegibbyhome", pay: 6.19 },
  { url: "https://www.tiktok.com/@sara_underwood/video/7093979497904639278", thumb: TK_THUMB_BASE + "t007.jpg", handle: "@sara_underwood", pay: 6.92 },
  { url: "https://www.tiktok.com/@lifeprettyhacks/video/7095678883097349422", thumb: TK_THUMB_BASE + "t008.jpg", handle: "@lifeprettyhacks", pay: 7.65 },
  { url: "https://www.tiktok.com/@jess_and_jake/video/7093244268487216426", thumb: TK_THUMB_BASE + "t009.jpg", handle: "@jess_and_jake", pay: 8.38 },
  { url: "https://www.tiktok.com/@ericafabric/video/7098200756213386498", thumb: TK_THUMB_BASE + "t010.jpg", handle: "@ericafabric", pay: 9.11 },
  { url: "https://www.tiktok.com/@jesswalkerdesign/video/7668071893542472967", thumb: TK_THUMB_BASE + "t011.jpg", handle: "@jesswalkerdesign", pay: 5.84 },
  { url: "https://www.tiktok.com/@camtanart/video/7471831555195850030", thumb: TK_THUMB_BASE + "t012.jpg", handle: "@camtanart", pay: 6.57 },
  { url: "https://www.tiktok.com/@json.creates/video/7674026663134432543", thumb: TK_THUMB_BASE + "t013.jpg", handle: "@json.creates", pay: 7.30 },
  { url: "https://www.tiktok.com/@itsajart/video/7581928520461471031", thumb: TK_THUMB_BASE + "t014.jpg", handle: "@itsajart", pay: 8.03 },
  { url: "https://www.tiktok.com/@nasstak/video/7673994633923317023", thumb: TK_THUMB_BASE + "t015.jpg", handle: "@nasstak", pay: 8.76 },
  { url: "https://www.tiktok.com/@kalebcorbinart/video/7492794332345371935", thumb: TK_THUMB_BASE + "t016.jpg", handle: "@kalebcorbinart", pay: 9.49 },
  { url: "https://www.tiktok.com/@itsajart/video/7557366326042430733", thumb: TK_THUMB_BASE + "t017.jpg", handle: "@itsajart", pay: 6.22 },
  { url: "https://www.tiktok.com/@ekoaopas_art/video/7664283362600865045", thumb: TK_THUMB_BASE + "t018.jpg", handle: "@ekoaopas_art", pay: 6.95 },
  { url: "https://www.tiktok.com/@grayson_kepley/video/7675457341520678158", thumb: TK_THUMB_BASE + "t019.jpg", handle: "@grayson_kepley", pay: 7.68 },
  { url: "https://www.tiktok.com/@funnycats0ftiktok/video/7318797175255813422", thumb: TK_THUMB_BASE + "t020.jpg", handle: "@funnycats0ftiktok", pay: 8.41 },
  { url: "https://www.tiktok.com/@funnychild007/video/7389571002277121310", thumb: TK_THUMB_BASE + "t021.jpg", handle: "@funnychild007", pay: 9.14 },
  { url: "https://www.tiktok.com/@viralblitzrealm/video/7333330245862329642", thumb: TK_THUMB_BASE + "t022.jpg", handle: "@viralblitzrealm", pay: 5.87 },
  { url: "https://www.tiktok.com/@khian.kb/video/7345156504657448235", thumb: TK_THUMB_BASE + "t023.jpg", handle: "@khian.kb", pay: 6.60 },
  { url: "https://www.tiktok.com/@sjw2022659/video/7335484656218901792", thumb: TK_THUMB_BASE + "t024.jpg", handle: "@sjw2022659", pay: 7.33 },
  { url: "https://www.tiktok.com/@animalfactspods/video/7376006567533137198", thumb: TK_THUMB_BASE + "t025.jpg", handle: "@animalfactspods", pay: 8.06 },
  { url: "https://www.tiktok.com/@hoest/video/7291711021654248709", thumb: TK_THUMB_BASE + "t026.jpg", handle: "@hoest", pay: 8.79 },
  { url: "https://www.tiktok.com/@doseofmemez/video/7219156406224620842", thumb: TK_THUMB_BASE + "t027.jpg", handle: "@doseofmemez", pay: 5.52 },
  { url: "https://www.tiktok.com/@xoxo4jojo/video/6886885040471543045", thumb: TK_THUMB_BASE + "t028.jpg", handle: "@xoxo4jojo", pay: 6.25 },
  { url: "https://www.tiktok.com/@memecuck/video/7219670637546196266", thumb: TK_THUMB_BASE + "t029.jpg", handle: "@memecuck", pay: 6.98 },
  { url: "https://www.tiktok.com/@katies_wanderlust/video/7108933286520474885", thumb: TK_THUMB_BASE + "t030.jpg", handle: "@katies_wanderlust", pay: 7.71 },
  { url: "https://www.tiktok.com/@ashraejack/video/7106262709355728174", thumb: TK_THUMB_BASE + "t031.jpg", handle: "@ashraejack", pay: 8.44 },
  { url: "https://www.tiktok.com/@whakkko/video/7105525375354113326", thumb: TK_THUMB_BASE + "t032.jpg", handle: "@whakkko", pay: 9.17 },
  { url: "https://www.tiktok.com/@harrycollinsphotography/video/7113625355486891307", thumb: TK_THUMB_BASE + "t033.jpg", handle: "@harrycollinsphotography", pay: 5.90 },
  { url: "https://www.tiktok.com/@texasbeeworks/video/7113569565052865834", thumb: TK_THUMB_BASE + "t034.jpg", handle: "@texasbeeworks", pay: 6.63 },
  { url: "https://www.tiktok.com/@charitydean/video/7108534490745687339", thumb: TK_THUMB_BASE + "t035.jpg", handle: "@charitydean", pay: 7.36 },
  { url: "https://www.tiktok.com/@harrycollinsphotography/video/7109919170833272107", thumb: TK_THUMB_BASE + "t036.jpg", handle: "@harrycollinsphotography", pay: 8.09 },
  { url: "https://www.tiktok.com/@g3ographyl0ver/video/7106833192316947713", thumb: TK_THUMB_BASE + "t037.jpg", handle: "@g3ographyl0ver", pay: 8.82 },
  { url: "https://www.tiktok.com/@tylekki/video/7107805786209865003", thumb: TK_THUMB_BASE + "t038.jpg", handle: "@tylekki", pay: 5.55 },
  { url: "https://www.tiktok.com/@realcarterhughes/video/7122092363626859818", thumb: TK_THUMB_BASE + "t039.jpg", handle: "@realcarterhughes", pay: 6.28 },
  { url: "https://www.tiktok.com/@prairiechuck1/video/7122471934272474411", thumb: TK_THUMB_BASE + "t040.jpg", handle: "@prairiechuck1", pay: 7.01 },
  { url: "https://www.tiktok.com/@l0nelysoul0/video/7629582028886789406", thumb: TK_THUMB_BASE + "t041.jpg", handle: "@l0nelysoul0", pay: 7.74 },
  { url: "https://www.tiktok.com/@ben_b219/video/7359603634662886689", thumb: TK_THUMB_BASE + "t042.jpg", handle: "@ben_b219", pay: 8.47 },
  { url: "https://www.tiktok.com/@caylaray.photography/video/7274306272554437930", thumb: TK_THUMB_BASE + "t043.jpg", handle: "@caylaray.photography", pay: 9.20 },
  { url: "https://www.tiktok.com/@shereinabdelhady/video/7064703044331523375", thumb: TK_THUMB_BASE + "t044.jpg", handle: "@shereinabdelhady", pay: 5.93 },
  { url: "https://www.tiktok.com/@djthatabguy/video/7062056437106707759", thumb: TK_THUMB_BASE + "t045.jpg", handle: "@djthatabguy", pay: 6.66 },
  { url: "https://www.tiktok.com/@caralinerosee/video/7069503422751362346", thumb: TK_THUMB_BASE + "t046.jpg", handle: "@caralinerosee", pay: 7.39 },
  { url: "https://www.tiktok.com/@thevincentcole/video/7065835086591102255", thumb: TK_THUMB_BASE + "t047.jpg", handle: "@thevincentcole", pay: 8.12 },
  { url: "https://www.tiktok.com/@reaganmckeever/video/7064003812662758703", thumb: TK_THUMB_BASE + "t048.jpg", handle: "@reaganmckeever", pay: 8.85 },
  { url: "https://www.tiktok.com/@roblewy/video/7062061484246912303", thumb: TK_THUMB_BASE + "t049.jpg", handle: "@roblewy", pay: 5.58 },
  { url: "https://www.tiktok.com/@jakeportolese/video/7060894412821515567", thumb: TK_THUMB_BASE + "t050.jpg", handle: "@jakeportolese", pay: 6.31 },
  { url: "https://www.tiktok.com/@samgach/video/7065031827559533871", thumb: TK_THUMB_BASE + "t051.jpg", handle: "@samgach", pay: 7.04 },
  { url: "https://www.tiktok.com/@enjoyable_tips/video/7622342306351385887", thumb: TK_THUMB_BASE + "t052.jpg", handle: "@enjoyable_tips", pay: 7.77 },
  { url: "https://www.tiktok.com/@atiktokhazbin/video/6674379432339180806", thumb: TK_THUMB_BASE + "t053.jpg", handle: "@atiktokhazbin", pay: 8.50 },
  { url: "https://www.tiktok.com/@savanahmosss/video/6668368433396059398", thumb: TK_THUMB_BASE + "t054.jpg", handle: "@savanahmosss", pay: 9.23 },
  { url: "https://www.tiktok.com/@shrtcts/video/6683991699389156614", thumb: TK_THUMB_BASE + "t055.jpg", handle: "@shrtcts", pay: 5.96 },
  { url: "https://www.tiktok.com/@lucas_voron/video/6674676865350765830", thumb: TK_THUMB_BASE + "t056.jpg", handle: "@lucas_voron", pay: 6.69 },
  { url: "https://www.tiktok.com/@shrtcts/video/6683506166611315974", thumb: TK_THUMB_BASE + "t057.jpg", handle: "@shrtcts", pay: 7.42 },
  { url: "https://www.tiktok.com/@nissalynninteriors/video/6674722205382741253", thumb: TK_THUMB_BASE + "t058.jpg", handle: "@nissalynninteriors", pay: 8.15 },
  { url: "https://www.tiktok.com/@impatman/video/6684319854473776389", thumb: TK_THUMB_BASE + "t059.jpg", handle: "@impatman", pay: 8.88 },
  { url: "https://www.tiktok.com/@timredj/video/6682919408098086149", thumb: TK_THUMB_BASE + "t060.jpg", handle: "@timredj", pay: 5.61 },
  { url: "https://www.tiktok.com/@imkelsym/video/6683085454188760325", thumb: TK_THUMB_BASE + "t061.jpg", handle: "@imkelsym", pay: 6.34 },
  { url: "https://www.tiktok.com/@lifehacks0491/video/7643839803959594254", thumb: TK_THUMB_BASE + "t062.jpg", handle: "@lifehacks0491", pay: 7.07 },
  { url: "https://www.tiktok.com/@numero.coronado/video/7664617244789312799", thumb: TK_THUMB_BASE + "t063.jpg", handle: "@numero.coronado", pay: 7.80 },
  { url: "https://www.tiktok.com/@tracekdlmy9/video/7588916415625694495", thumb: TK_THUMB_BASE + "t064.jpg", handle: "@tracekdlmy9", pay: 8.53 },
  { url: "https://www.tiktok.com/@danny.kaoke/video/7606739086384139534", thumb: TK_THUMB_BASE + "t065.jpg", handle: "@danny.kaoke", pay: 9.26 },
  { url: "https://www.tiktok.com/@hieudang199598/video/7670085783969205537", thumb: TK_THUMB_BASE + "t066.jpg", handle: "@hieudang199598", pay: 5.99 },
  { url: "https://www.tiktok.com/@cactustherescue/video/7674653336087317791", thumb: TK_THUMB_BASE + "t067.jpg", handle: "@cactustherescue", pay: 6.72 },
  { url: "https://www.tiktok.com/@tailbitpets/video/7671002018269465887", thumb: TK_THUMB_BASE + "t068.jpg", handle: "@tailbitpets", pay: 7.45 },
  { url: "https://www.tiktok.com/@pawjoy_chop/video/7558731663576976648", thumb: TK_THUMB_BASE + "t069.jpg", handle: "@pawjoy_chop", pay: 8.18 },
  { url: "https://www.tiktok.com/@crazypetcrew/video/7671093419674045727", thumb: TK_THUMB_BASE + "t070.jpg", handle: "@crazypetcrew", pay: 8.91 },
  { url: "https://www.tiktok.com/@neonxstudio/video/7584981546797403393", thumb: TK_THUMB_BASE + "t071.jpg", handle: "@neonxstudio", pay: 5.64 },
  { url: "https://www.tiktok.com/@pets.squad/video/7669859644759690518", thumb: TK_THUMB_BASE + "t072.jpg", handle: "@pets.squad", pay: 6.37 },
  { url: "https://www.tiktok.com/@kknnqg2/video/7666285926116642079", thumb: TK_THUMB_BASE + "t073.jpg", handle: "@kknnqg2", pay: 7.10 },
  { url: "https://www.tiktok.com/@missobsessionasmr/video/7665820073877163277", thumb: TK_THUMB_BASE + "t074.jpg", handle: "@missobsessionasmr", pay: 7.83 },
  { url: "https://www.tiktok.com/@sand.tagious/video/7667994875530349855", thumb: TK_THUMB_BASE + "t075.jpg", handle: "@sand.tagious", pay: 8.56 },
  { url: "https://www.tiktok.com/@missfoxyasmr/video/7641950665820114190", thumb: TK_THUMB_BASE + "t076.jpg", handle: "@missfoxyasmr", pay: 9.29 },
  { url: "https://www.tiktok.com/@sickslicee/video/7522440998027332886", thumb: TK_THUMB_BASE + "t077.jpg", handle: "@sickslicee", pay: 6.02 },
  { url: "https://www.tiktok.com/@eatpayylove/video/7129614022420335918", thumb: TK_THUMB_BASE + "t078.jpg", handle: "@eatpayylove", pay: 6.75 },
  { url: "https://www.tiktok.com/@foodportofficial/video/7120988822057323819", thumb: TK_THUMB_BASE + "t079.jpg", handle: "@foodportofficial", pay: 7.48 },
  { url: "https://www.tiktok.com/@alvaresbernardo641/video/7117456603154173230", thumb: TK_THUMB_BASE + "t080.jpg", handle: "@alvaresbernardo641", pay: 8.21 },
  { url: "https://www.tiktok.com/@brittneeciara/video/7129629509506141483", thumb: TK_THUMB_BASE + "t081.jpg", handle: "@brittneeciara", pay: 8.94 },
  { url: "https://www.tiktok.com/@tblwsrrmm82/video/7128055258852363562", thumb: TK_THUMB_BASE + "t082.jpg", handle: "@tblwsrrmm82", pay: 5.67 },
  { url: "https://www.tiktok.com/@lelebr007/video/7115790826797747502", thumb: TK_THUMB_BASE + "t083.jpg", handle: "@lelebr007", pay: 6.40 },
  { url: "https://www.tiktok.com/@judyllee/video/7127283359952145669", thumb: TK_THUMB_BASE + "t084.jpg", handle: "@judyllee", pay: 7.13 },
  { url: "https://www.tiktok.com/@hunchoslv/video/7121426044816559402", thumb: TK_THUMB_BASE + "t085.jpg", handle: "@hunchoslv", pay: 7.86 },
  { url: "https://www.tiktok.com/@maplesweetgolden/video/7119058738199268654", thumb: TK_THUMB_BASE + "t086.jpg", handle: "@maplesweetgolden", pay: 8.59 },
  { url: "https://www.tiktok.com/@patternta/video/7116854244870737194", thumb: TK_THUMB_BASE + "t087.jpg", handle: "@patternta", pay: 9.32 },
  { url: "https://www.tiktok.com/@chipsinasandwich/video/7120044900577496366", thumb: TK_THUMB_BASE + "t088.jpg", handle: "@chipsinasandwich", pay: 6.05 },
  { url: "https://www.tiktok.com/@howtobasic/video/7116882296376003842", thumb: TK_THUMB_BASE + "t089.jpg", handle: "@howtobasic", pay: 6.78 },
  { url: "https://www.tiktok.com/@kittyfoodie/video/7472498907759660319", thumb: TK_THUMB_BASE + "t090.jpg", handle: "@kittyfoodie", pay: 7.51 },
  { url: "https://www.tiktok.com/@erica_sherwood/video/7602058378319285559", thumb: TK_THUMB_BASE + "t091.jpg", handle: "@erica_sherwood", pay: 8.24 },
  { url: "https://www.tiktok.com/@harrycollinsphotography/video/7115940100185574702", thumb: TK_THUMB_BASE + "t092.jpg", handle: "@harrycollinsphotography", pay: 8.97 },
  { url: "https://www.tiktok.com/@diegobormidaartist/video/7667934350813564193", thumb: TK_THUMB_BASE + "t093.jpg", handle: "@diegobormidaartist", pay: 5.70 },
  { url: "https://www.tiktok.com/@aver.uu/video/7670298500583771405", thumb: TK_THUMB_BASE + "t094.jpg", handle: "@aver.uu", pay: 6.43 },
  { url: "https://www.tiktok.com/@creative_art886/video/7614380846367149326", thumb: TK_THUMB_BASE + "t095.jpg", handle: "@creative_art886", pay: 7.16 },
  { url: "https://www.tiktok.com/@aashkasotero/video/7114276574391733547", thumb: TK_THUMB_BASE + "t096.jpg", handle: "@aashkasotero", pay: 7.89 },
  { url: "https://www.tiktok.com/@dkkiesz/video/6683270888340589830", thumb: TK_THUMB_BASE + "t097.jpg", handle: "@dkkiesz", pay: 8.62 },
  { url: "https://www.tiktok.com/@dirty.little.man/video/6672822299080543493", thumb: TK_THUMB_BASE + "t098.jpg", handle: "@dirty.little.man", pay: 9.35 },
  { url: "https://www.tiktok.com/@itsreallyalexaa/video/6679514374752701701", thumb: TK_THUMB_BASE + "t099.jpg", handle: "@itsreallyalexaa", pay: 6.08 },
  { url: "https://www.tiktok.com/@motiv8.peace/video/7666852242837949699", thumb: TK_THUMB_BASE + "t100.jpg", handle: "@motiv8.peace", pay: 6.81 },
  { url: "https://www.tiktok.com/@aidreamcode/video/7675320587014786317", thumb: TK_THUMB_BASE + "t101.jpg", handle: "@aidreamcode", pay: 7.54 },
  { url: "https://www.tiktok.com/@thextractionlab/video/7667197781089504545", thumb: TK_THUMB_BASE + "t102.jpg", handle: "@thextractionlab", pay: 8.27 },
  { url: "https://www.tiktok.com/@asmrstation3/video/7675464172083154206", thumb: TK_THUMB_BASE + "t103.jpg", handle: "@asmrstation3", pay: 9.00 },
  { url: "https://www.tiktok.com/@iviethefoodie/video/7454360589993905438", thumb: TK_THUMB_BASE + "t104.jpg", handle: "@iviethefoodie", pay: 5.73 },
  { url: "https://www.tiktok.com/@staticandbenel/video/7102147765144161582", thumb: TK_THUMB_BASE + "t105.jpg", handle: "@staticandbenel", pay: 6.46 },
  { url: "https://www.tiktok.com/@fat_teddy_bear/video/7673347117510937869", thumb: TK_THUMB_BASE + "t106.jpg", handle: "@fat_teddy_bear", pay: 7.19 },
  { url: "https://www.tiktok.com/@ozzieartcorner/video/7669353945839488270", thumb: TK_THUMB_BASE + "t107.jpg", handle: "@ozzieartcorner", pay: 7.92 },
  { url: "https://www.tiktok.com/@merritt.media/video/7665756331206380813", thumb: TK_THUMB_BASE + "t108.jpg", handle: "@merritt.media", pay: 8.65 },
  { url: "https://www.tiktok.com/@exploreamerica7/video/7553609394173267213", thumb: TK_THUMB_BASE + "t109.jpg", handle: "@exploreamerica7", pay: 9.38 },
  { url: "https://www.tiktok.com/@gashi/video/7449895905123241246", thumb: TK_THUMB_BASE + "t110.jpg", handle: "@gashi", pay: 6.11 },
  { url: "https://www.tiktok.com/@cw_compay/video/7423680782276758817", thumb: TK_THUMB_BASE + "t111.jpg", handle: "@cw_compay", pay: 6.84 },
  { url: "https://www.tiktok.com/@elbitarsisters/video/7110706233203559681", thumb: TK_THUMB_BASE + "t112.jpg", handle: "@elbitarsisters", pay: 7.57 },
  { url: "https://www.tiktok.com/@aaron.vankampen/video/6977090903731129606", thumb: TK_THUMB_BASE + "t113.jpg", handle: "@aaron.vankampen", pay: 8.30 },
  { url: "https://www.tiktok.com/@glizzyputtinyadown/video/7471122577004498219", thumb: TK_THUMB_BASE + "t114.jpg", handle: "@glizzyputtinyadown", pay: 9.03 },
  { url: "https://www.tiktok.com/@andrewzviolin/video/7567107451737181470", thumb: TK_THUMB_BASE + "t115.jpg", handle: "@andrewzviolin", pay: 5.76 },
  { url: "https://www.tiktok.com/@stephbagan/video/7019090717767208198", thumb: TK_THUMB_BASE + "t116.jpg", handle: "@stephbagan", pay: 6.49 },
  { url: "https://www.tiktok.com/@wesickandtired/video/7370822906999328043", thumb: TK_THUMB_BASE + "t117.jpg", handle: "@wesickandtired", pay: 7.22 },
  { url: "https://www.tiktok.com/@ellagracecarls0n_/video/7384851972844719402", thumb: TK_THUMB_BASE + "t118.jpg", handle: "@ellagracecarls0n_", pay: 7.95 },
  { url: "https://www.tiktok.com/@idk_evaa/video/7367509888043420970", thumb: TK_THUMB_BASE + "t119.jpg", handle: "@idk_evaa", pay: 8.68 }
];
// ROTAÇÃO DIÁRIA: mostra 15 vídeos diferentes por dia, girando pela data.
// 120 vídeos / 15 por dia = 8 dias até repetir. Determinístico (todo mundo vê o mesmo no mesmo dia).
function earnDayIndex() { return Math.floor(Date.now() / 86400000); }
function todaysVideos() {
  var per = EARN_MAX_PER_DAY, total = TIKTOK_VIDEOS.length;
  var start = (earnDayIndex() * per) % total;
  var out = [];
  for (var k = 0; k < per; k++) out.push(TIKTOK_VIDEOS[(start + k) % total]);
  return out;
}
// tkVideo(i): o i-ésimo vídeo DO DIA (posição no grid 0..14), já rotacionado.
function tkVideo(i) { return todaysVideos()[i % EARN_MAX_PER_DAY]; }
function videoPay(i) { return tkVideo(i).pay; }
function fmt(n) { return n.toFixed(2); }
var EARN_MIN_PAY = Math.min.apply(null, TIKTOK_VIDEOS.map(function (v) { return v.pay; }));
var EARN_MAX_PAY = Math.max.apply(null, TIKTOK_VIDEOS.map(function (v) { return v.pay; }));

function earnDayKey() { return "tk_earn_day" + (state.email ? ":" + state.email : ""); }
function earnTotalKey() { return "tk_earn_total" + (state.email ? ":" + state.email : ""); }
function earnTodayStr() { var d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }

function loadEarnDay() {
  try {
    var o = JSON.parse(localStorage.getItem(earnDayKey()) || "{}");
    if (o.date !== earnTodayStr() || !Array.isArray(o.watched)) return { date: earnTodayStr(), watched: [] };
    return o;
  } catch (e) { return { date: earnTodayStr(), watched: [] }; }
}
function saveEarnDay(o) { try { localStorage.setItem(earnDayKey(), JSON.stringify(o)); } catch (e) {} }
function earnTotal() { try { return parseFloat(localStorage.getItem(earnTotalKey())) || 0; } catch (e) { return 0; } }
function addEarnTotal(v) { try { localStorage.setItem(earnTotalKey(), String(earnTotal() + v)); } catch (e) {} }

// Atualiza o "Total balance" do card Home: base + tudo o que já ganhou nos vídeos.
function updateBalanceUI(bump) {
  var el = document.getElementById("home-balance");
  if (!el) return;
  var total = EARN_BASE_BALANCE + earnTotal();
  var parts = total.toFixed(2).split(".");
  var dollars = parseInt(parts[0], 10).toLocaleString("en-US");
  el.innerHTML = "$" + dollars + '.<span class="bc-cents">' + parts[1] + "</span>";
  if (bump) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
}

function renderEarn() {
  var emailEl = document.getElementById("earn-email");
  if (emailEl) emailEl.textContent = state.email;
  var locked = document.getElementById("earn-locked");
  var active = document.getElementById("earn-active");
  if (!locked || !active) return;

  if (!state.analysisStart) {
    locked.style.display = "flex"; active.style.display = "none";
    var elSub = locked.querySelector(".el-sub");
    if (elSub) elSub.innerHTML = txt("Submit your documents", "Set up your payout account") + " to unlock <strong>Watch &amp; Earn</strong> and start boosting your balance every day while your analysis runs.";
    var elBtn = document.getElementById("earn-send-docs");
    if (elBtn) elBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> ' + txt("Send documents", "Set up payout account");
    return;
  }
  locked.style.display = "none"; active.style.display = "block";

  var day = loadEarnDay();
  var watched = day.watched.length;
  // soma os valores REAIS (quebrados) dos vídeos já assistidos hoje
  var todayEarned = 0;
  for (var wi = 0; wi < day.watched.length; wi++) todayEarned += videoPay(day.watched[wi]);
  document.getElementById("earn-today").textContent = "$" + fmt(todayEarned);
  document.getElementById("earn-count").textContent = watched + " of " + EARN_MAX_PER_DAY + " videos watched";
  document.getElementById("earn-pervideo").textContent = "$" + fmt(EARN_MIN_PAY) + "–$" + fmt(EARN_MAX_PAY) + " each";
  document.getElementById("earn-bar").style.width = Math.min(100, (watched / EARN_MAX_PER_DAY) * 100) + "%";
  document.getElementById("earn-done").style.display = watched >= EARN_MAX_PER_DAY ? "flex" : "none";

  var pend = loadPending();
  var grid = document.getElementById("earn-grid");
  grid.innerHTML = "";
  for (var i = 0; i < EARN_MAX_PER_DAY; i++) {
    var isW = day.watched.indexOf(i) !== -1;
    var isPend = !isW && pend && pend.index === i; // foi pro TikTok, falta resgatar
    var vid = tkVideo(i);
    var card = document.createElement("div");
    card.className = "earn-card" + (isW ? " watched" : "") + (isPend ? " pending" : "");
    card.innerHTML =
      '<div class="ec-thumb" style="background-image:url(' + vid.thumb + ')"></div>' +
      '<div class="ec-shade"></div>' +
      '<div class="ec-reward">+$' + fmt(vid.pay) + '</div>' +
      '<div class="ec-play"><svg viewBox="0 0 24 24" width="20" height="20" fill="#fff"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>' +
      '<div class="ec-done"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>' +
      (isPend ? '<div class="ec-claim">Claim +$' + fmt(vid.pay) + "</div>" : "") +
      '<div class="ec-handle">' + vid.handle + "</div>";
    if (!isW) { (function (idx) { card.onclick = function () { openVideo(idx); }; })(i); }
    grid.appendChild(card);
  }
}

// Vídeo "pendente": a pessoa foi pro TikTok e ainda não voltou pra resgatar.
// Fica salvo — se ela fechar o app e voltar depois, o resgate continua disponível.
var _earnPending = null; // { index, leftAt }
function earnPendKey() { return "tk_earn_pending" + (state.email ? ":" + state.email : ""); }
function loadPending() { try { return JSON.parse(localStorage.getItem(earnPendKey()) || "null"); } catch (e) { return null; } }
function savePending(p) { try { p ? localStorage.setItem(earnPendKey(), JSON.stringify(p)) : localStorage.removeItem(earnPendKey()); } catch (e) {} _earnPending = p; }

// Salva os ganhos no SERVIDOR (fire-and-forget; se cair, o localStorage segura e
// ressincroniza no próximo boot). Não trava a UI — o crédito já aconteceu localmente.
function syncEarnToServer() {
  if (!SERVER_SYNC) return; // clone offline: ganhos so no localStorage
  if (!state.email) return;
  var day = loadEarnDay();
  fetch("/api/analysis", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: state.email, action: "earn", earnTotal: earnTotal(), earnDay: day }),
  }).catch(function () {});
}

function creditVideo(index) {
  var d = loadEarnDay();
  if (d.watched.indexOf(index) === -1) { d.watched.push(index); saveEarnDay(d); addEarnTotal(videoPay(index)); syncEarnToServer(); }
  savePending(null);
  document.getElementById("vpc-amount").textContent = "+$" + fmt(videoPay(index));
  document.getElementById("vp-panel").style.display = "none";
  document.getElementById("vp-credited").classList.add("show");
  updateBalanceUI(true);
  try {
    var actx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = actx.createOscillator(), g = actx.createGain();
    osc.type = "sine"; osc.frequency.value = 1046; g.gain.setValueAtTime(0.25, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.5);
    osc.connect(g); g.connect(actx.destination); osc.start(); osc.stop(actx.currentTime + 0.5);
  } catch (e) {}
  setTimeout(function () { document.getElementById("video-player").classList.remove("open"); renderEarn(); }, 1600);
}

function openVideo(index) {
  var day = loadEarnDay();
  if (day.watched.indexOf(index) !== -1) return;
  if (day.watched.length >= EARN_MAX_PER_DAY) { showToast("Daily limit reached — come back tomorrow!", ""); return; }

  var vp = document.getElementById("video-player");
  var vid = tkVideo(index);
  var media = document.getElementById("vp-media");
  media.style.backgroundImage = "url(" + vid.thumb + ")";
  media.style.backgroundSize = "cover";
  media.style.backgroundPosition = "center";
  document.getElementById("vp-caption").textContent = vid.handle + " · TikTok";
  document.getElementById("vp-reward").textContent = "+$" + fmt(vid.pay);
  document.getElementById("vp-wait-amt").textContent = "+$" + fmt(vid.pay);
  document.getElementById("vp-credited").classList.remove("show");
  document.getElementById("vp-panel").style.display = "flex";

  // se já tinha ido nesse vídeo e voltou, mostra direto o "waiting/claim"; senão, a instrução
  var pend = loadPending();
  var samePending = pend && pend.index === index;
  document.getElementById("vp-hint").innerHTML = samePending
    ? "Did you finish the video? Come back and tap below to claim your <strong>+$" + fmt(vid.pay) + "</strong>."
    : "Watch this video on TikTok, then come back to claim your <strong>+$" + fmt(vid.pay) + "</strong>.";
  document.getElementById("vp-cta-label").textContent = samePending ? "Claim my reward" : "Watch on TikTok";
  document.getElementById("vp-waiting").style.display = "none";
  vp.classList.add("open");
  vp.setAttribute("data-index", index);
}

function goWatch() {
  var vp = document.getElementById("video-player");
  var index = parseInt(vp.getAttribute("data-index"), 10);
  if (isNaN(index)) return;
  var pend = loadPending();

  // Segunda vez (já foi e voltou): o botão vira "Claim" — credita se cumpriu o tempo mínimo.
  if (pend && pend.index === index && pend.leftAt) {
    var waited = (Date.now() - pend.leftAt) / 1000;
    if (waited >= EARN_MIN_WATCH_S) { creditVideo(index); return; }
    showToast("Keep watching! Come back after the video ends.", "");
    return;
  }

  // Primeira vez: abre o TikTok e arma o pendente.
  var url = TIKTOK_VIDEOS.length ? tkVideo(index).url : "https://www.tiktok.com/foryou";
  savePending({ index: index, leftAt: Date.now() });
  window.open(url, "_blank");
  document.getElementById("vp-hint").innerHTML = "Watch the full video, then come back here to claim your <strong>+$" + fmt(tkVideo(index).pay) + "</strong>.";
  document.getElementById("vp-cta-label").textContent = "Claim my reward";
  document.getElementById("vp-waiting").style.display = "flex";
}

// Quando a pessoa VOLTA pro app (troca de aba / volta do TikTok): credita se cumpriu o tempo.
function onReturnFromWatch() {
  var pend = loadPending();
  if (!pend || !pend.leftAt) return;
  var waited = (Date.now() - pend.leftAt) / 1000;
  var vpOpen = document.getElementById("video-player").classList.contains("open");
  if (waited >= EARN_MIN_WATCH_S) {
    if (vpOpen && document.getElementById("video-player").getAttribute("data-index") == pend.index) {
      creditVideo(pend.index); // player aberto nesse vídeo: credita na hora
    } else {
      showToast("Your +$" + fmt(videoPay(pend.index)) + " is ready to claim in Earn!", "success");
      renderEarn();
    }
  }
}

function closeVideo() { document.getElementById("video-player").classList.remove("open"); }

(function () {
  var vc = document.getElementById("vp-close");
  if (vc) vc.addEventListener("click", closeVideo);
  var cta = document.getElementById("vp-cta");
  if (cta) cta.addEventListener("click", goWatch);
  var sd = document.getElementById("earn-send-docs");
  if (sd) sd.addEventListener("click", function () { openUploadModal(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) onReturnFromWatch(); });
  window.addEventListener("focus", onReturnFromWatch);
  updateBalanceUI(false);
})();

// ================================================================
// BOOT (no FINAL: garante que todas as funções/consts já existem)
// ================================================================
loadState();

// MODO DEMO (só teste local): abrir com ?demo=<fase> entra logado SEM tocar o servidor.
//   earn = análise em andamento (dia 3), aba Earn
//   docs = análise em andamento (dia 3), aba Analysis
//   day7 = análise APROVADA (dia 7), aba Analysis (tela de aprovação → pedir conta de recebimento)
//   pay  = PAGAMENTO em andamento (dia 2 de 6), aba Analysis
// Inócuo em produção (ninguém usa esse link).
var _demoM = /[?&]demo=([a-z0-9]+)/.exec(location.search);
var _demo = _demoM ? _demoM[1] : null;
if (_demo) {
  var _D = 24 * 60 * 60 * 1000;
  state.email = state.email || "demo@local.test";
  if (_demo === "day7") {
    state.analysisStart = Date.now() - 8 * _D; state.serverDay = 7;
    state.manualReview = false; state.manualServerDay = null;
  } else if (_demo === "pay") {
    state.analysisStart = Date.now() - 9 * _D; state.serverDay = 7;
    state.manualReview = true; state.manualStart = Date.now() - 1 * _D; state.manualServerDay = 2;
  } else {
    if (!state.analysisStart) state.analysisStart = Date.now() - 2 * _D; // dia 3
    state.serverDay = 3;
  }
}

route();
(async function () {
  if (_demo) {
    if (_demo === "earn") { renderEarn(); updateBalanceUI(false); switchTab("earn"); maybeShowOffer(); return; }
    switchTab("analysis"); maybeShowOffer(); return; // não toca o servidor no modo demo
  }
  if (state.email) {
    await syncWithServer("get"); // pega a data real do servidor e migra quem ja tinha comecado
    route();                      // re-renderiza com o dia correto vindo do servidor
  }
  maybeShowOffer();
})();
