/* ============================================================
   EN 直接予約フォーム（4ステップ）
   日付は 'YYYY-MM-DD' 文字列で管理（日本時間基準）。
   金額は /api/quote（サーバー計算）のみを表示に使う。
   ============================================================ */

import { PRICING } from '../lib/pricing.js';

let state = {
  checkin: null,
  checkout: null,
  adults: 2,
  infants: 0,
  paymentMethod: 'online',
  bbq: false,
  sauna: false,
  earlyCheckin: false,
  agree: false,
};

let bookedNights = new Set();
let blockedDates = new Set();
let availLoaded = false;
let todayStr = '';
let lastQuote = null;

let currentStep = 1;

export function initBooking() {
  const $ = (id) => document.getElementById(id);
  const stepEls = document.querySelectorAll('.booking-step');
  const progressEls = document.querySelectorAll('.booking-progress__step');

  const errEls = {
    1: $('step1Error'),
    2: $('step2Error'),
    3: $('step3Error'),
  };
  function showErr(step, msg) {
    const el = errEls[step];
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* ---------- 日付ユーティリティ（文字列ベース・日本時間） ---------- */
  function tokyoToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
  }
  todayStr = tokyoToday();

  function parts(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fmt(y, m, d) {
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  function addDays(s, n) {
    const p = parts(s);
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    const p2 = (x) => String(x).padStart(2, '0');
    return dt.getUTCFullYear() + '-' + p2(dt.getUTCMonth() + 1) + '-' + p2(dt.getUTCDate());
  }
  function nights(a, b) {
    const p1 = parts(a);
    const p2 = parts(b);
    return Math.round((Date.UTC(p2.y, p2.m - 1, p2.d) - Date.UTC(p1.y, p1.m - 1, p1.d)) / 86400000);
  }
  function fmtJa(s) {
    const p = parts(s);
    return (p.m) + '月' + (p.d) + '日';
  }
  function fmtJaFull(s) {
    const p = parts(s);
    return p.y + '年' + p.m + '月' + p.d + '日';
  }

  /* ---------- 空室データ ---------- */
  let availRanges = []; /* 取得済み範囲 [{from, to}] */

  async function ensureAvailability(fromS, toS) {
    /* すでに取得済みの範囲に含まれるなら再取得しない */
    const covered = availRanges.some(function (r) { return r.from <= fromS && toS <= r.to; });
    if (covered) return false;
    try {
      const r = await fetch('/api/availability?from=' + fromS + '&to=' + toS, { cache: 'no-store' });
      const d = await r.json();
      if (!r.ok) return false;
      (d.booked || []).forEach(function (n) { bookedNights.add(n); });
      (d.blocked || []).forEach(function (n) { blockedDates.add(n); });
      availRanges.push({ from: fromS, to: toS });
      availLoaded = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  function isNightBlocked(s) {
    return bookedNights.has(s) || blockedDates.has(s) || isBeforeCutoff(s);
  }

  /* 当日予約可（チェックイン当日の15:00まで選択可・日本時間。サーバーが最終判定） */
  function isBeforeCutoff(s) {
    const jst = new Date(Date.now() + 9 * 3600000);
    const pastCutoffTime = (jst.getUTCHours() * 60 + jst.getUTCMinutes()) >= 15 * 60;
    return s < todayStr || (s === todayStr && pastCutoffTime);
  }
  function rangeHasBlocked(a, b) {
    /* [a, b) の各夜が空いているか */
    for (let s = a; s < b; s = addDays(s, 1)) {
      if (isNightBlocked(s)) return true;
    }
    return false;
  }

  /* ---------- カレンダー描画 ---------- */
  let calY = parseInt(todayStr.slice(0, 4), 10);
  let calM = parseInt(todayStr.slice(5, 7), 10);
  const calGrid = $('calGrid');
  const calMonthEl = $('calMonth');

  function renderCalendar() {
    if (!calGrid) return;
    calMonthEl.textContent = calY + '年 ' + calM + '月';
    const __dim = new Date(calY, calM, 0).getDate();
    const __last = fmt(calY, calM, __dim);
    const __first = fmt(calY, calM, 1);
    ensureAvailability(__first, __last).then(function (fetched) {
      if (fetched) renderCalendar();
    });
    const first = new Date(calY, calM - 1, 1);
    const daysInMonth = new Date(calY, calM, 0).getDate();
    const startDow = first.getDay();
    let html = '';
    for (const d of ['日', '月', '火', '水', '木', '金', '土']) html += '<div class="cal-header">' + d + '</div>';
    for (let i = 0; i < startDow; i++) html += '<div class="cal-day cal-day--empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const s = fmt(calY, calM, d);
      const past = s < todayStr;
      const blocked = !past && isNightBlocked(s);
      const isCheckoutOk = state.checkin && !state.checkout && s > state.checkin && !isNightBlocked(s);
      let cls = 'cal-day';
      if (past) cls += ' cal-day--past';
      if (s === todayStr) cls += ' cal-day--today';
      if (state.checkin === s || state.checkout === s) cls += ' cal-day--selected';
      if (state.checkin && state.checkout && s > state.checkin && s < state.checkout && !blocked) cls += ' cal-day--in-range';
      if (blocked) cls += ' cal-day--blocked';
      const interactive = !past && (!blocked || isCheckoutOk);
      const attrs = interactive
        ? ' role="button" tabindex="0" aria-label="' + (calM) + '月' + d + '日"'
        : ' aria-disabled="true"';
      html += '<div class="' + cls + '" data-date="' + s + '"' + attrs + '>' + d + '</div';
      html += '>';
    }
    calGrid.innerHTML = html;

    calGrid.querySelectorAll('.cal-day[role="button"]').forEach((cell) => {
      const activate = function (refocus) {
        const s = cell.dataset.date;
        handleDateClick(s);
        if (refocus) {
          const again = calGrid.querySelector('[data-date="' + s + '"]');
          if (again && again.getAttribute('role') === 'button') again.focus();
        }
      };
      cell.addEventListener('click', function () { activate(false); });
      cell.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(true);
        }
      });
    });
  }

  /* ---------- 日付選択ロジック ---------- */
  function handleDateClick(s) {
    if (!state.checkin || (state.checkin && state.checkout)) {
      /* 新しくチェックインを選ぶ */
      state.checkin = s;
      state.checkout = null;
    } else if (s <= state.checkin) {
      /* チェックイン以前をクリック → 打ち直し */
      state.checkin = s;
      state.checkout = null;
    } else if (rangeHasBlocked(state.checkin, s)) {
      /* 間に予約済み夜がある → チェックインの打ち直し */
      state.checkin = s;
      state.checkout = null;
      showErr(1, '選択した範囲に予約済みの日程が含まれるため、日付を選び直しました。');
    } else {
      state.checkout = s;
      showErr(1, '');
    }
    state.checkout = state.checkout || null;
    renderCalendar();
    updateDateDisplay();
    refreshQuote();
  }

  function updateDateDisplay() {
    document.getElementById('dispCheckin').textContent = state.checkin ? fmtJa(state.checkin) : '選択してください';
    document.getElementById('dispCheckout').textContent = state.checkout ? fmtJa(state.checkout) : '選択してください';
    const n = state.checkin && state.checkout ? nights(state.checkin, state.checkout) : 0;
    document.getElementById('dispNights').textContent = n > 0 ? n + '泊' : '';
  }

  /* ---------- 人数セレクト（合計16名上限） ---------- */
  const adultsEl = document.getElementById('adults');
  const childrenEl = document.getElementById('children');

  function rebuildChildrenOptions() {
    const adults = parseInt(adultsEl.value, 10) || 0;
    const maxChildren = PRICING.maxInfants != null ? PRICING.maxInfants : 5;
    const current = parseInt(childrenEl.value, 10) || 0;
    const target = Math.min(current, maxChildren);
    let html = '';
    for (let n = 0; n <= maxChildren; n++) {
      html += '<option value="' + n + '"' + (n === target ? ' selected' : '') + '>' + (n === 0 ? 'なし' : n + '名') + '</option>';
    }
    childrenEl.innerHTML = html;
  }

  function buildAdultOptions() {
    let html = '';
    for (let n = 1; n <= (PRICING.maxAdults || PRICING.maxPaidGuests || 16); n++) {
      html += '<option value="' + n + '"' + (n === 2 ? ' selected' : '') + '>' + n + '名</option>';
    }
    adultsEl.innerHTML = html;
  }

  /* ---------- サマリーとサーバー見積り ---------- */
  function yen(n) {
    return Number(n || 0).toLocaleString('ja-JP');
  }

  async function refreshQuote() {
    const sumCheckin = document.getElementById('sumCheckin');
    const sumCheckout = document.getElementById('sumCheckout');
    const sumNights = document.getElementById('sumNights');
    const sumGuests = document.getElementById('sumGuests');
    const sumSubtotal = document.getElementById('sumSubtotal');
    const sumPerNight = document.getElementById('sumPerNight');
    const sumTotal = document.getElementById('sumTotal');
    const sumOptions = document.getElementById('sumOptions');

    sumCheckin.textContent = state.checkin ? fmtJa(state.checkin) : '-';
    sumCheckout.textContent = state.checkout ? fmtJa(state.checkout) : '-';
    sumNights.textContent = state.checkin && state.checkout ? nights(state.checkin, state.checkout) + '泊' : '-';
    const adults = parseInt(adultsEl.value, 10) || 0;
    const infants = parseInt(childrenEl.value, 10) || 0;
    state.adults = adults;
    state.infants = infants;
    state.paymentMethod = document.querySelector('input[name=\"paymentMethod\"]:checked') ? document.querySelector('input[name=\"paymentMethod\"]:checked').value : 'online';
    sumGuests.textContent = '大人（3歳以上）' + adults + '名 / 2歳以下' + infants + '名';

    const optNames = [];
    if (state.bbq) optNames.push('BBQ');
    if (state.sauna) optNames.push('サウナ');
    if (state.earlyCheckin) optNames.push('アーリーIN');
    sumOptions.textContent = optNames.length ? optNames.join('・') + '（当日現金）' : '当日現金払い';

    if (!state.checkin || !state.checkout) {
      sumSubtotal.textContent = '-';
      sumPerNight.textContent = '-';
      sumTotal.textContent = '¥-';
      lastQuote = null;
      return;
    }
    try {
      const r = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkin: state.checkin, checkout: state.checkout,
          adults: adults, children: children,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.error === 'unavailable') showErr(1, 'この日程は直前の予約が入ったため選択できません。日付を選び直してください。');
        sumSubtotal.textContent = '-';
        sumPerNight.textContent = '-';
        sumTotal.textContent = '¥-';
        lastQuote = null;
        return;
      }
      lastQuote = d;
      sumSubtotal.textContent = '¥' + yen(d.subtotal);
      sumPerNight.textContent = '¥' + yen(d.perNight);
      sumTotal.textContent = '¥' + yen(d.onlineTotal);
      const onsiteEl = document.getElementById('sumOnsite');
      if (onsiteEl) onsiteEl.textContent = d.onsiteAmount > 0 ? '¥' + yen(d.onsiteAmount) : 'なし';
      const onlineEl = document.getElementById('sumOnline');
      if (onlineEl) onlineEl.textContent = '¥' + yen(d.onlineTotal);
    } catch (e) {
      sumSubtotal.textContent = '-';
      sumPerNight.textContent = '-';
      sumTotal.textContent = '¥-';
      lastQuote = null;
    }
  }

  /* ---------- ステップ遷移 ---------- */
  function goToStep(n) {
    stepEls.forEach(function (el) { el.classList.remove('is-active'); });
    const target = document.getElementById('step' + n);
    if (target) target.classList.add('is-active');
    progressEls.forEach(function (el) {
      const s = parseInt(el.dataset.step, 10);
      el.classList.remove('is-active', 'is-done');
      if (s === n) el.classList.add('is-active');
      else if (s < n) el.classList.add('is-done');
    });
    currentStep = n;
    const reserve = document.getElementById('reserve');
    if (reserve && n > 1) {
      reserve.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ---------- Step 1 → 2 ---------- */
  document.getElementById('toStep2').addEventListener('click', function () {
    showErr(1, '');
    if (!state.checkin || !state.checkout) {
      showErr(1, 'チェックイン日とチェックアウト日をカレンダーから選択してください。');
      return;
    }
    const n = nights(state.checkin, state.checkout);
    if (n < PRICING.minNights) {
      showErr(1, 'チェックアウトはチェックイン日の翌日以降を選択してください。');
      return;
    }
    if (n > PRICING.maxNights) {
      showErr(1, '連泊は最大' + PRICING.maxNights + '泊までです。' + PRICING.maxNights + '泊を超える長期のご利用はお電話にてご相談ください。');
      return;
    }
    if (rangeHasBlocked(state.checkin, state.checkout)) {
      showErr(1, '選択した範囲に予約済み・受付停止の日程が含まれています。日付を選び直してください。');
      return;
    }
    state.adults = parseInt(adultsEl.value, 10) || 0;
    state.infants = parseInt(childrenEl.value, 10) || 0;
    if (!lastQuote) {
      showErr(1, '料金の取得に失敗しました。日付を選び直してください。');
      return;
    }
    goToStep(2);
  });

  /* ---------- Step 2 検証 → 3 ---------- */
  function validateStep2() {
    const get = (id) => (document.getElementById(id).value || '').trim();
    clearErrors();
    const errors = [];
    const required = {
      lastName: '姓を入力してください',
      firstName: '名を入力してください',
      lastNameKana: 'セイを入力してください',
      firstNameKana: 'メイを入力してください',
      email: 'メールアドレスを入力してください',
      phone: '電話番号を入力してください',
      zip: '郵便番号を入力してください',
      prefecture: '都道府県を入力してください',
      address: '市区町村・番地を入力してください',
    };
    Object.keys(required).forEach(function (id) {
      const el = document.getElementById(id);
      if (!get(id)) {
        showFieldError(el, required[id]);
        errors.push(id);
      }
    });
    if (errors.length) return false;
    const kanaL = get('lastNameKana');
    const kanaF = get('firstNameKana');
    if (!/^[ぁ-んァ-ヶー・\s]+$/.test(kanaL)) { fieldErr('lastNameKana', 'カタカナ（ひらがな）で入力してください'); errors.push('k'); }
    if (!/^[ぁ-んァ-ヶー・\s]+$/.test(kanaF)) { fieldErr('firstNameKana', 'カタカナ（ひらがな）で入力してください'); errors.push('k'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('email'))) { fieldErr('email', '正しいメールアドレスを入力してください'); errors.push('e'); }
    if (!/^\d{10,11}$/.test(get('phone').replace(/[-\s]/g, ''))) { fieldErr('phone', '電話番号は10〜11桁の数字で入力してください'); errors.push('p'); }
    if (!/^\d{7}$/.test(get('zip').replace(/\D/g, ''))) { fieldErr('zip', '郵便番号は7桁で入力してください'); errors.push('z'); }
    return errors.length === 0;
  }

  function showFieldError(el, msg) {
    el.style.borderColor = 'rgba(200, 80, 80, 0.7)';
    const wrap = el.parentElement;
    const existing = wrap.querySelector('.field-error');
    if (existing) existing.remove();
    const span = document.createElement('span');
    span.className = 'field-error';
    span.textContent = msg;
    wrap.appendChild(span);
  }
  function fieldErr(id, msg) {
    showFieldError(document.getElementById(id), msg);
  }
  function clearErrors() {
    document.querySelectorAll('#step2 .field-error').forEach(function (e) { e.remove(); });
    document.querySelectorAll('#step2 input, #step2 select, #step2 textarea').forEach(function (e) { e.style.borderColor = ''; });
  }

  /* ---------- 郵便番号 → 住所自動入力 ---------- */
  const zipEl = document.getElementById('zip');
  zipEl.addEventListener('blur', function () {
    const zip = zipEl.value.replace(/\D/g, '');
    if (zip.length !== 7) return;
    fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + zip)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.results && d.results.length > 0) {
          const r = d.results[0];
          document.getElementById('prefecture').value = r.address1;
          const addr = (r.address2 || '') + (r.address3 || '');
          const addressEl = document.getElementById('address');
          if (!addressEl.value.trim()) addressEl.value = addr;
        }
      })
      .catch(function () {});
  });

  /* ---------- Step 3 確認画面 ---------- */
  function buildConfirmation() {
    const get = (id) => (document.getElementById(id).value || '').trim();
    const adults = parseInt(adultsEl.value, 10) || 0;
    const infants = parseInt(childrenEl.value, 10) || 0;
    const q = lastQuote;
    const payLabel = state.paymentMethod === 'onsite'
      ? '宿泊料のみオンライン決済／オプションは現地払い'
      : '宿泊料とオプションをまとめてオンライン決済';
    const optNames = [];
    if (state.bbq) optNames.push('BBQセット（当日現金 ¥2,000）');
    if (state.sauna) optNames.push('テントサウナ（当日現金 ¥2,000）');
    if (state.earlyCheckin) optNames.push('アーリーチェックイン12:00〜（当日現金 ¥5,000）');

    const rows = []
      .concat('<div class="confirm-box__section"><h4>宿泊期間</h4>')
      .concat('<div class="confirm-box__row"><span>チェックイン</span><span>' + esc(fmtJaFull(state.checkin)) + ' 15:00〜22:00</span></div>')
      .concat('<div class="confirm-box__row"><span>チェックアウト</span><span>' + esc(fmtJaFull(state.checkout)) + ' 〜12:00</span></div>')
      .concat('<div class="confirm-box__row"><span>宿泊数</span><span>' + nights(state.checkin, state.checkout) + '泊</span></div>')
      .concat('<div class="confirm-box__row"><span>宿泊人数</span><span>大人（3歳以上）' + adults + '名 / 2歳以下' + infants + '名</span></div>')
      .concat('<div class="confirm-box__row"><span>到着予定</span><span>' + esc(get('arrival')) + '</span></div>')
      .concat('</div>')
      .concat('<div class="confirm-box__section"><h4>お客様情報</h4>')
      .concat('<div class="confirm-box__row"><span>お名前</span><span>' + esc(get('lastName') + ' ' + get('firstName')) + '（' + esc(get('lastNameKana') + ' ' + get('firstNameKana')) + '）</span></div>')
      .concat('<div class="confirm-box__row"><span>メール</span><span>' + esc(get('email')) + '</span></div>')
      .concat('<div class="confirm-box__row"><span>電話番号</span><span>' + esc(get('phone')) + '</span></div>')
      .concat('<div class="confirm-box__row"><span>住所</span><span>〒' + esc(get('zip')) + ' ' + esc(get('prefecture')) + esc(get('address')) + '</span></div>')
      .concat('<div class="confirm-box__row"><span>オプション希望</span><span>' + esc(optNames.length ? optNames.join(' / ') : 'なし') + '</span></div>')
      .concat('<div class="confirm-box__row"><span>お支払い方法</span><span>' + esc(payLabel) + '</span></div>')
      .concat(get('notes') ? '<div class="confirm-box__row"><span>要望</span><span>' + esc(get('notes')) + '</span></div>' : '')
      .concat('</div>')
      .concat('<div class="confirm-box__section"><h4>お支払い</h4>')
      .concat('<div class="confirm-box__row"><span>宿泊料（' + nights(state.checkin, state.checkout) + '泊 / 3歳以上' + adults + '名・税込）</span><span>¥' + yen(q.subtotal) + '</span></div>')
      .concat('<div class="confirm-box__row"><span>1泊あたり</span><span>¥' + yen(q.perNight) + '</span></div>')
      .concat(q.optionsOnline > 0 ? '<div class="confirm-box__row"><span>オプション（オンライン決済分）</span><span>¥' + yen(q.optionsOnline) + '</span></div>' : '')
      .concat('<div class="confirm-box__total"><span>オンライン決済額（税込）</span><span>¥' + yen(q.onlineTotal) + '</span></div>')
      .concat('<div class="confirm-box__row"><span>現地支払予定額</span><span>' + (q.onsiteAmount > 0 ? '¥' + yen(q.onsiteAmount) + '（当日現金）' : 'なし') + '</span></div>')
      .concat(state.earlyCheckin ? '<div class="confirm-box__row"><span>アーリーチェックイン</span><span>希望受付中（承認後に確定・現地精算 ¥5,000）</span></div>' : '')
      .concat('</div>');
    document.getElementById('confirmBox').innerHTML = rows.join('');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ---------- 送信 → Stripe Checkout へ ---------- */
  document.getElementById('toStep3').addEventListener('click', function () {
    if (!validateStep2()) return;
    buildConfirmation();
    goToStep(3);
  });
  document.getElementById('backToStep1').addEventListener('click', function () { goToStep(1); });
  document.getElementById('backToStep2').addEventListener('click', function () { goToStep(2); });

  const submitBtn = document.getElementById('submitBooking');
  submitBtn.addEventListener('click', async function () {
    showErr(3, '');
    if (!document.getElementById('agreeTerms').checked) {
      showErr(3, '利用規約およびキャンセルポリシーに同意してください。');
      return;
    }
    if (!lastQuote) {
      showErr(3, '料金情報が取得できていません。日付を選び直してください。');
      return;
    }
    const get = (id) => (document.getElementById(id).value || '').trim();
    submitBtn.disabled = true;
    submitBtn.textContent = '決済ページへ移動中…';
    try {
      let requestId = sessionStorage.getItem('en_request_id');
      if (!requestId) {
        requestId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
        sessionStorage.setItem('en_request_id', requestId);
      }
      const r = await fetch('/api/booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: requestId,
          checkin: state.checkin,
          checkout: state.checkout,
          adults: parseInt(adultsEl.value, 10),
          infants: parseInt(childrenEl.value, 10) || 0,
          bbq: state.bbq,
          sauna: state.sauna,
          earlyCheckin: state.earlyCheckin,
          paymentMethod: state.paymentMethod,
          name: get('lastName') + ' ' + get('firstName'),
          kana: get('lastNameKana') + ' ' + get('firstNameKana'),
          email: get('email'),
          phone: get('phone'),
          zip: get('zip'),
          prefecture: get('prefecture'),
          address: get('address'),
          arrival: get('arrival'),
          notes: get('notes'),
        }),
      });
      const d = await r.json().catch(function () { return {}; });
      if (r.ok && d.url) {
        window.location.href = d.url;
        return;
      }
      if (d.error === 'payments_disabled' || d.error === 'not_configured') {
        showErr(3, '現在、オンライン決済の受付準備中です。お手数ですがお電話（0773-21-6424）にてご予約ください。');
      } else if (d.error === 'pending_exists') {
        showErr(3, '同じ連絡先で未完了の予約があります。決済を完了するか、30分経過後に再度お試しください。お急ぎの場合はお電話（0773-21-6424）にてご連絡ください。');
      } else if (d.error === 'unavailable') {
        showErr(3, 'この日程は直前に予約が入りました。日付を選び直してください。');
        goToStep(1);
      } else if (d.error === 'capacity_exceeded' || d.error === 'invalid_adults' || d.error === 'invalid_children') {
        showErr(3, '宿泊人数をご確認ください（最大16名）。');
        goToStep(1);
      } else {
        showErr(3, '予約処理で問題が発生しました。お手数ですがお電話（0773-21-6424）にてご連絡ください。');
      }
    } catch (e) {
      showErr(3, '通信エラーが発生しました。もう一度お試しください。');
    }
    submitBtn.disabled = false;
    submitBtn.textContent = '決済ページへ進む';
  });

  /* オプション・人数のイベント */
  adultsEl.addEventListener('change', function () {
    rebuildChildrenOptions();
    state.adults = parseInt(adultsEl.value, 10) || 0;
    refreshQuote();
  });
  document.querySelectorAll('input[name="paymentMethod"]').forEach(function (r) {
    r.addEventListener('change', function () { refreshQuote(); });
  });
  childrenEl.addEventListener('change', function () {
    state.infants = parseInt(childrenEl.value, 10) || 0;
    refreshQuote();
  });
  [['optBbq', 'bbq'], ['optSauna', 'sauna'], ['optEarly', 'earlyCheckin']].forEach(function (pair) {
    const el = document.getElementById(pair[0]);
    if (el) el.addEventListener('change', function () { state[pair[1]] = el.checked; refreshQuote(); });
  });

  /* ---------- カレンダー月送り ---------- */
  document.getElementById('calPrev').addEventListener('click', function () {
    calM--;
    if (calM < 1) { calM = 12; calY--; }
    const min = todayStr.slice(0, 7);
    if ((calY + '-' + String(calM).padStart(2, '0')) < min) {
      calY = parseInt(todayStr.slice(0, 4), 10);
      calM = parseInt(todayStr.slice(5, 7), 10);
    }
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', function () {
    calM++;
    if (calM > 12) { calM = 1; calY++; }
    renderCalendar();
  });

  /* ---------- 初期化 ---------- */
  buildAdultOptions();
  rebuildChildrenOptions();
  renderCalendar();
  updateDateDisplay();
  refreshQuote();
  ensureAvailability(fmt(calY, calM, 1), fmt(calY, calM, new Date(calY, calM, 0).getDate())).then(function (fetched) {
    if (fetched) renderCalendar();
  });

  /* ---------- 決済戻りの処理 ---------- */
  const params = new URLSearchParams(window.location.search);
  const returnBookingId = params.get('booking');
  const sessionId = params.get('session_id');
  const canceled = params.get('canceled');

  if (canceled === '1' && returnBookingId) {
    goToStep(1);
    showErr(1, '決済がキャンセルされました。もう一度最初からお手続きください。');
    history.replaceState(null, '', window.location.pathname);
    return;
  }
  if (returnBookingId && /^EN-/.test(returnBookingId)) {
    handleReturn(returnBookingId, sessionId);
  }

  async function handleReturn(id, sessionId) {
    goToStep(4);
    const title = document.getElementById('completeTitle');
    const statusEl = document.getElementById('completeStatus');
    const summary = document.getElementById('completeSummary');
    if (!sessionId) {
      statusEl.textContent = '予約情報の確認中に問題が発生しました。お手数ですがお電話（0773-21-6424）にてご連絡ください。（予約番号: ' + id + '）';
      return;
    }
    statusEl.textContent = '決済の完了を確認しています…';
    let d = null;
    for (let i = 0; i < 6; i++) {
      try {
        const r = await fetch('/api/verify?id=' + encodeURIComponent(id) + '&session_id=' + encodeURIComponent(sessionId));
        if (r.ok) { d = await r.json(); break; }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 2000); });
    }
    if (!d) {
      statusEl.textContent = '決済状況の確認ができませんでした。決済が完了している場合でも、まもなく確定メールをお送りします。お急ぎの場合はお電話（0773-21-6424）にてご連絡ください。（予約番号: ' + id + '）';
      return;
    }
    renderComplete(d);
  }

  function renderComplete(b) {
    const title = document.getElementById('completeTitle');
    const statusEl = document.getElementById('completeStatus');
    const summary = document.getElementById('completeSummary');
    const yen = function (n) { return Number(n || 0).toLocaleString('ja-JP'); };
    const optNames = [];
    if (b.options.bbq) optNames.push('BBQセット');
    if (b.options.sauna) optNames.push('テントサウナ');
    if (b.options.earlyCheckin) optNames.push('アーリーチェックイン');
    let html = ''
      + '<div class="confirm-box__section"><h4>予約番号</h4>'
      + '<div class="confirm-box__row"><span>' + esc(b.id) + '</span><span></span></div></div>'
      + '<div class="confirm-box__section"><h4>宿泊期間</h4>'
      + '<div class="confirm-box__row"><span>チェックイン</span><span>' + esc(b.checkin) + ' 15:00〜22:00</span></div>'
      + '<div class="confirm-box__row"><span>チェックアウト</span><span>' + esc(b.checkout) + ' 〜12:00</span></div>'
      + '<div class="confirm-box__row"><span>宿泊人数</span><span>大人（3歳以上）' + b.adults + '名 / 2歳以下' + (b.infants || 0) + '名</span></div>'
      + '</div>'
      + '<div class="confirm-box__section"><h4>お支払い</h4>'
      + '<div class="confirm-box__row"><span>オンライン決済額（税込）</span><span>¥' + yen(b.priceJpy) + '</span></div>'
      + '<div class="confirm-box__row"><span>現地支払予定額</span><span>' + (b.onsiteAmount > 0 ? '¥' + yen(b.onsiteAmount) + '（当日現金）' : 'なし') + '</span></div>'
      + (optNames.length ? '<div class="confirm-box__row"><span>オプション希望</span><span>' + esc(optNames.join('・')) + '（当日現金払い）</span></div>' : '')
      + '</div>';
    summary.innerHTML = html;

    if (b.status === 'confirmed') {
      title.textContent = 'ご予約が確定しました';
      statusEl.textContent = '予約番号 ' + b.id + ' で予約を承りました。確認メール（' + (b.emailStatus === 'sent' ? '送信済み' : '準備中') + '）をご確認ください。';
    } else if (b.status === 'pending_payment') {
      title.textContent = '決済の確認中です';
      statusEl.textContent = '決済の完了確認ができていません。まもなく確定メールをお送りします。完了していない場合は30分で自動解放されます。（予約番号: ' + b.id + '）';
    } else {
      title.textContent = '予約を完了できませんでした';
      statusEl.textContent = '決済が完了していない可能性があります。お手数ですがお電話（0773-21-6424）にてご連絡ください。（予約番号: ' + b.id + '）';
    }
  }

  document.getElementById('backToTop').addEventListener('click', function (e) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}
