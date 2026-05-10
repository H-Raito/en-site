/* ========================================
   EN — Interactions
   ======================================== */

/* EmailJS Configuration — 無料枠: 月200通
   https://www.emailjs.com/ でアカウント作成後、以下を設定してください */
var EMAILJS_PUBLIC_KEY = 'nvqZQNOzpBT6d7kWl';
var EMAILJS_SERVICE_ID = 'service_4ly1nul';
var EMAILJS_TEMPLATE_CUSTOMER = 'template_pj9zbri';
var EMAILJS_TEMPLATE_BUSINESS = 'template_jp9jbso';

(function() {
  if (typeof emailjs !== 'undefined' && EMAILJS_PUBLIC_KEY !== 'YOUR_PUBLIC_KEY') {
    emailjs.init(EMAILJS_PUBLIC_KEY);
  }
})();

document.addEventListener('DOMContentLoaded', () => {

  /* ---------- Scroll Appear (.sd system) ---------- */
  const sdElements = document.querySelectorAll('.sd');
  const sdObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('appear');
        sdObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });

  sdElements.forEach((el) => sdObserver.observe(el));


  /* ---------- Hero Parallax ---------- */
  const heroSlideshow = document.querySelector('.hero__slideshow');
  if (heroSlideshow) {
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scrolled = window.scrollY;
          if (scrolled < window.innerHeight) {
            heroSlideshow.style.transform = 'translateY(' + (scrolled * 0.3) + 'px)';
          }
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }


  /* ---------- Header Background ---------- */
  const header = document.getElementById('header');
  const updateHeader = () => {
    header.classList.toggle('has-bg', window.scrollY > 80);
  };
  window.addEventListener('scroll', updateHeader, { passive: true });
  updateHeader();


  /* ---------- Side Panel ---------- */
  const menuBtn = document.getElementById('menuBtn');
  const panel = document.getElementById('sidePanel');
  const panelClose = document.getElementById('panelClose');
  const panelOverlay = document.getElementById('panelOverlay');

  function openPanel() {
    panel.classList.add('is-open');
    panelOverlay.classList.add('is-visible');
    menuBtn.classList.add('is-open');
    document.body.style.overflow = 'hidden';
  }

  function closePanel() {
    panel.classList.remove('is-open');
    panelOverlay.classList.remove('is-visible');
    menuBtn.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  menuBtn.addEventListener('click', () => {
    panel.classList.contains('is-open') ? closePanel() : openPanel();
  });
  panelClose.addEventListener('click', closePanel);
  panelOverlay.addEventListener('click', closePanel);

  document.querySelectorAll('.side-panel__link').forEach((link) => {
    link.addEventListener('click', () => closePanel());
  });


  /* ---------- Hero Slideshow ---------- */
  const slides = document.querySelectorAll('.hero__slide');
  let current = 0;
  const total = slides.length;

  setInterval(() => {
    slides[current].classList.remove('is-active');
    current = (current + 1) % total;
    slides[current].classList.add('is-active');
  }, 5000);


  /* ---------- Gallery Horizontal Scroll ---------- */
  const track = document.getElementById('galleryTrack');
  const prevBtn = document.getElementById('galleryPrev');
  const nextBtn = document.getElementById('galleryNext');
  const counter = document.getElementById('galleryCounter');

  if (track && prevBtn && nextBtn && counter) {
    const items = track.querySelectorAll('.gallery__item');

    function getScrollAmount() {
      const first = items[0];
      if (!first) return 300;
      return first.offsetWidth + 16;
    }

    function updateCounter() {
      const scrollPos = track.scrollLeft;
      const itemW = getScrollAmount();
      const visibleCount = Math.round(track.offsetWidth / itemW);
      const idx = Math.round(scrollPos / itemW) + visibleCount;
      const num = String(Math.min(idx, items.length)).padStart(2, '0');
      counter.textContent = num + ' / ' + String(items.length).padStart(2, '0');
    }

    prevBtn.addEventListener('click', () => {
      track.scrollBy({ left: -getScrollAmount(), behavior: 'smooth' });
    });

    nextBtn.addEventListener('click', () => {
      track.scrollBy({ left: getScrollAmount(), behavior: 'smooth' });
    });

    track.addEventListener('scroll', updateCounter, { passive: true });
  }


  /* ---------- Smooth Scroll for Anchors ---------- */
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const target = document.querySelector(anchor.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });


  /* ========================================
     CALENDAR & BOOKING
     ======================================== */

  const PRICE_PER_NIGHT = 60000;
  const TAX_RATE = 0.10;

  /* DOM refs */
  const calGrid = document.getElementById('calGrid');
  const calMonthEl = document.getElementById('calMonth');
  const calPrevBtn = document.getElementById('calPrev');
  const calNextBtn = document.getElementById('calNext');

  const adultsEl = document.getElementById('adults');
  const childrenEl = document.getElementById('children');

  const dispCheckin = document.getElementById('dispCheckin');
  const dispCheckout = document.getElementById('dispCheckout');
  const dispNights = document.getElementById('dispNights');

  const sumCheckin = document.getElementById('sumCheckin');
  const sumCheckout = document.getElementById('sumCheckout');
  const sumNights = document.getElementById('sumNights');
  const sumGuests = document.getElementById('sumGuests');
  const sumSubtotal = document.getElementById('sumSubtotal');
  const sumTax = document.getElementById('sumTax');
  const sumTotal = document.getElementById('sumTotal');

  /* Calendar state */
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let calYear = today.getFullYear();
  let calMonthIdx = today.getMonth();
  let selectedCheckin = null;
  let selectedCheckout = null;
  let pickingCheckin = true;

  const dayLabels = ['日', '月', '火', '水', '木', '金', '土'];

  /* Date helpers */
  function formatDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '/' + m + '/' + day;
  }

  function formatDateShort(d) {
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function isSameDay(a, b) {
    return a && b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function isInRange(d, start, end) {
    return start && end && d > start && d < end;
  }

  function calcNights() {
    if (!selectedCheckin || !selectedCheckout) return 0;
    return Math.round((selectedCheckout - selectedCheckin) / (1000 * 60 * 60 * 24));
  }

  /* ---------- Render Calendar ---------- */
  function renderCalendar() {
    calMonthEl.textContent = calYear + '年 ' + (calMonthIdx + 1) + '月';

    var html = '';

    dayLabels.forEach(function(label) {
      html += '<div class="cal-header">' + label + '</div>';
    });

    var firstDay = new Date(calYear, calMonthIdx, 1);
    var lastDay = new Date(calYear, calMonthIdx + 1, 0);
    var startDow = firstDay.getDay();

    for (var i = 0; i < startDow; i++) {
      html += '<div class="cal-day cal-day--empty"></div>';
    }

    for (var d = 1; d <= lastDay.getDate(); d++) {
      var date = new Date(calYear, calMonthIdx, d);
      date.setHours(0, 0, 0, 0);

      var cls = 'cal-day';
      if (date < today) cls += ' cal-day--past';
      if (isSameDay(date, today)) cls += ' cal-day--today';
      if (isSameDay(date, selectedCheckin) || isSameDay(date, selectedCheckout)) cls += ' cal-day--selected';
      if (isInRange(date, selectedCheckin, selectedCheckout)) cls += ' cal-day--in-range';

      var disabled = date < today ? ' data-disabled="true"' : '';
      html += '<div class="' + cls + '" data-date="' + calYear + '-' + calMonthIdx + '-' + d + '"' + disabled + '>' + d + '</div>';
    }

    calGrid.innerHTML = html;

    calGrid.querySelectorAll('.cal-day:not(.cal-day--past):not(.cal-day--empty)').forEach(function(cell) {
      cell.addEventListener('click', function() {
        var parts = cell.dataset.date.split('-');
        var clicked = new Date(parseInt(parts[0]), parseInt(parts[1]), parseInt(parts[2]));
        clicked.setHours(0, 0, 0, 0);
        handleDateClick(clicked);
      });
    });
  }

  function handleDateClick(date) {
    if (pickingCheckin || !selectedCheckin || date <= selectedCheckin) {
      selectedCheckin = date;
      selectedCheckout = null;
      pickingCheckin = false;
    } else {
      selectedCheckout = date;
      pickingCheckin = true;
    }
    renderCalendar();
    updateDateDisplay();
    updateSidebar();
  }

  /* ---------- Update Displays ---------- */
  function updateDateDisplay() {
    dispCheckin.textContent = selectedCheckin ? formatDateShort(selectedCheckin) : '選択してください';
    dispCheckout.textContent = selectedCheckout ? formatDateShort(selectedCheckout) : '選択してください';
    var nights = calcNights();
    dispNights.textContent = nights > 0 ? nights + '泊' : '';
  }

  function updateSidebar() {
    var nights = calcNights();
    var adults = parseInt(adultsEl.value) || 0;
    var children = parseInt(childrenEl.value) || 0;

    sumCheckin.textContent = selectedCheckin ? formatDateShort(selectedCheckin) : '-';
    sumCheckout.textContent = selectedCheckout ? formatDateShort(selectedCheckout) : '-';
    sumNights.textContent = nights > 0 ? nights + '泊' : '-';
    sumGuests.textContent = '大人' + adults + '名 / 子供' + children + '名';

    var subtotal = PRICE_PER_NIGHT * Math.max(nights, 0);
    var tax = Math.floor(subtotal * TAX_RATE);
    var total = subtotal + tax;

    sumSubtotal.textContent = nights > 0 ? '¥' + subtotal.toLocaleString() : '-';
    sumTax.textContent = nights > 0 ? '¥' + tax.toLocaleString() : '-';
    sumTotal.textContent = nights > 0 ? '¥' + total.toLocaleString() : '¥-';
  }

  /* Month navigation */
  calPrevBtn.addEventListener('click', function() {
    calMonthIdx--;
    if (calMonthIdx < 0) { calMonthIdx = 11; calYear--; }
    if (calYear < today.getFullYear() || (calYear === today.getFullYear() && calMonthIdx < today.getMonth())) {
      calYear = today.getFullYear();
      calMonthIdx = today.getMonth();
    }
    renderCalendar();
  });

  calNextBtn.addEventListener('click', function() {
    calMonthIdx++;
    if (calMonthIdx > 11) { calMonthIdx = 0; calYear++; }
    renderCalendar();
  });

  adultsEl.addEventListener('change', updateSidebar);
  childrenEl.addEventListener('change', updateSidebar);

  renderCalendar();
  updateSidebar();


  /* ========================================
     FORM VALIDATION
     ======================================== */

  function showFieldError(id, msg) {
    var el = document.getElementById(id);
    el.style.borderColor = 'rgba(200, 80, 80, 0.7)';
    var existing = el.parentElement.querySelector('.field-error');
    if (existing) existing.remove();
    var span = document.createElement('span');
    span.className = 'field-error';
    span.textContent = msg;
    el.parentElement.appendChild(span);
  }

  function clearFieldError(id) {
    var el = document.getElementById(id);
    el.style.borderColor = '';
    var existing = el.parentElement.querySelector('.field-error');
    if (existing) existing.remove();
  }

  function clearAllErrors() {
    document.querySelectorAll('.field-error').forEach(function(e) { e.remove(); });
    document.querySelectorAll('.form-field input, .form-field select, .form-field textarea').forEach(function(e) {
      e.style.borderColor = '';
    });
  }

  /* 入力時にエラーをリアルタイム解除 */
  ['lastName', 'firstName', 'lastNameKana', 'firstNameKana', 'email', 'phone', 'zip', 'prefecture', 'address'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', function() { clearFieldError(id); });
    }
  });

  /* 郵便番号 → 住所自動入力 */
  var zipEl = document.getElementById('zip');
  zipEl.addEventListener('blur', function() {
    var zip = zipEl.value.replace(/[^\d]/g, '');
    if (zip.length !== 7) return;
    fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + zip)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.results && data.results.length > 0) {
          var r = data.results[0];
          document.getElementById('prefecture').value = r.address1;
          var addr = (r.address2 || '') + (r.address3 || '');
          var addressEl = document.getElementById('address');
          if (!addressEl.value.trim()) {
            addressEl.value = addr;
          }
          clearFieldError('prefecture');
          clearFieldError('address');
        }
      })
      .catch(function() { /* 自動入力失敗は無視 */ });
  });

  function validateStep2() {
    clearAllErrors();
    var errors = [];

    /* 必須チェック */
    var required = {
      lastName: '姓を入力してください',
      firstName: '名を入力してください',
      lastNameKana: 'セイを入力してください',
      firstNameKana: 'メイを入力してください',
      email: 'メールアドレスを入力してください',
      phone: '電話番号を入力してください',
      zip: '郵便番号を入力してください',
      prefecture: '都道府県を入力してください',
      address: '市区町村・番地を入力してください'
    };

    Object.keys(required).forEach(function(id) {
      var el = document.getElementById(id);
      if (!el.value.trim()) {
        showFieldError(id, required[id]);
        errors.push(id);
      }
    });

    if (errors.length > 0) return false;

    /* 形式チェック */
    var emailVal = document.getElementById('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      showFieldError('email', '正しいメールアドレスを入力してください');
      errors.push('email');
    }

    var phoneVal = document.getElementById('phone').value.replace(/[-\s]/g, '');
    if (!/^\d{10,11}$/.test(phoneVal)) {
      showFieldError('phone', '電話番号は10〜11桁の数字で入力してください');
      errors.push('phone');
    }

    var zipVal = zipEl.value.replace(/[^\d]/g, '');
    if (zipVal.length !== 7) {
      showFieldError('zip', '郵便番号は7桁で入力してください');
      errors.push('zip');
    }

    return errors.length === 0;
  }


  /* ========================================
     BOOKING FORM STEPS
     ======================================== */

  var stepEls = document.querySelectorAll('.booking-step');
  var progressSteps = document.querySelectorAll('.booking-progress__step');
  var currentStep = 1;

  function goToStep(step) {
    stepEls.forEach(function(el) { el.classList.remove('is-active'); });
    document.getElementById('step' + step).classList.add('is-active');

    progressSteps.forEach(function(el) {
      var s = parseInt(el.dataset.step);
      el.classList.remove('is-active', 'is-done');
      if (s === step) el.classList.add('is-active');
      else if (s < step) el.classList.add('is-done');
    });

    currentStep = step;

    var reserveSection = document.getElementById('reserve');
    if (reserveSection) {
      reserveSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* Step 1 → 2 */
  document.getElementById('toStep2').addEventListener('click', function() {
    if (!selectedCheckin || !selectedCheckout) {
      alert('チェックイン日とチェックアウト日をカレンダーで選択してください。');
      return;
    }
    if (calcNights() < 1) {
      alert('チェックアウト日はチェックイン日の翌日以降を選択してください。');
      return;
    }
    goToStep(2);
  });

  /* Step 2 → 3 */
  document.getElementById('toStep3').addEventListener('click', function() {
    if (!validateStep2()) return;
    buildConfirmation();
    goToStep(3);
  });

  /* Back buttons */
  document.getElementById('backToStep1').addEventListener('click', function() { goToStep(1); });
  document.getElementById('backToStep2').addEventListener('click', function() { goToStep(2); });


  /* ---------- Build Confirmation ---------- */
  function buildConfirmation() {
    var nights = calcNights();
    var adults = parseInt(adultsEl.value);
    var children = parseInt(childrenEl.value);
    var subtotal = PRICE_PER_NIGHT * nights;
    var tax = Math.floor(subtotal * TAX_RATE);
    var total = subtotal + tax;

    var name = document.getElementById('lastName').value + ' ' + document.getElementById('firstName').value;
    var arrival = document.getElementById('arrival').value;

    var html = ''
      + '<div class="confirm-box__section">'
      + '  <h4>宿泊期間</h4>'
      + '  <div class="confirm-box__row"><span>チェックイン</span><span>' + formatDate(selectedCheckin) + ' 15:00〜</span></div>'
      + '  <div class="confirm-box__row"><span>チェックアウト</span><span>' + formatDate(selectedCheckout) + ' 〜10:00</span></div>'
      + '  <div class="confirm-box__row"><span>宿泊数</span><span>' + nights + '泊</span></div>'
      + '  <div class="confirm-box__row"><span>宿泊人数</span><span>大人' + adults + '名 / 子供' + children + '名</span></div>'
      + '  <div class="confirm-box__row"><span>到着予定</span><span>' + arrival + '</span></div>'
      + '</div>'
      + '<div class="confirm-box__section">'
      + '  <h4>お客様情報</h4>'
      + '  <div class="confirm-box__row"><span>お名前</span><span>' + name + '</span></div>'
      + '  <div class="confirm-box__row"><span>メール</span><span>' + document.getElementById('email').value + '</span></div>'
      + '  <div class="confirm-box__row"><span>電話番号</span><span>' + document.getElementById('phone').value + '</span></div>'
      + '  <div class="confirm-box__row"><span>住所</span><span>〒' + document.getElementById('zip').value + ' ' + document.getElementById('prefecture').value + document.getElementById('address').value + '</span></div>';

    if (document.getElementById('notes').value) {
      html += '  <div class="confirm-box__row"><span>備考</span><span>' + document.getElementById('notes').value + '</span></div>';
    }

    html += '</div>'
      + '<div class="confirm-box__section">'
      + '  <h4>お支払い</h4>'
      + '  <div class="confirm-box__row"><span>宿泊料（' + nights + '泊）</span><span>¥' + subtotal.toLocaleString() + '</span></div>'
      + '  <div class="confirm-box__row"><span>消費税（10%）</span><span>¥' + tax.toLocaleString() + '</span></div>'
      + '  <div class="confirm-box__total">'
      + '    <span>合計（税込）</span>'
      + '    <span>¥' + total.toLocaleString() + '</span>'
      + '  </div>'
      + '</div>';

    document.getElementById('confirmBox').innerHTML = html;
  }


  /* ---------- Submit ---------- */
  document.getElementById('submitBooking').addEventListener('click', async function() {
    var agreed = document.getElementById('agreeTerms').checked;
    if (!agreed) {
      alert('利用規約およびキャンセルポリシーに同意してください。');
      return;
    }

    var btn = document.getElementById('submitBooking');
    var originalText = btn.textContent;
    btn.textContent = '送信中...';
    btn.disabled = true;
    btn.style.opacity = '0.6';

    var name = document.getElementById('lastName').value + ' ' + document.getElementById('firstName').value;
    var nights = calcNights();
    var adults = parseInt(adultsEl.value);
    var children = parseInt(childrenEl.value);
    var subtotal = PRICE_PER_NIGHT * nights;
    var tax = Math.floor(subtotal * TAX_RATE);
    var total = subtotal + tax;

    var templateParams = {
      customer_name: name,
      customer_email: document.getElementById('email').value,
      customer_phone: document.getElementById('phone').value,
      customer_address: '〒' + document.getElementById('zip').value + ' ' + document.getElementById('prefecture').value + document.getElementById('address').value,
      checkin_date: formatDate(selectedCheckin),
      checkout_date: formatDate(selectedCheckout),
      nights: nights,
      adults: adults,
      children: children,
      arrival: document.getElementById('arrival').value,
      subtotal: subtotal.toLocaleString(),
      tax: tax.toLocaleString(),
      total: total.toLocaleString(),
      notes: document.getElementById('notes').value || 'なし',
    };

    /* EmailJS が未設定の場合のフォールバック */
    if (EMAILJS_PUBLIC_KEY === 'YOUR_PUBLIC_KEY' || typeof emailjs === 'undefined') {
      console.warn('EmailJS not configured. Booking data:', templateParams);
      setTimeout(function() {
        showComplete(templateParams);
      }, 1500);
      return;
    }

    try {
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_CUSTOMER, templateParams);
      await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_BUSINESS, templateParams);
      showComplete(templateParams);
    } catch (error) {
      console.error('EmailJS error:', error);
      alert('送信に失敗しました。\nお手数ですが、お電話またはメールにてご連絡ください。');
      btn.textContent = originalText;
      btn.disabled = false;
      btn.style.opacity = '';
    }
  });

  /* ---------- Success Screen ---------- */
  function showComplete(params) {
    document.getElementById('confirmEmail').textContent = params.customer_email;

    var summaryHtml = ''
      + '<div class="confirm-box__section">'
      + '  <h4>宿泊期間</h4>'
      + '  <div class="confirm-box__row"><span>チェックイン</span><span>' + params.checkin_date + ' 15:00〜</span></div>'
      + '  <div class="confirm-box__row"><span>チェックアウト</span><span>' + params.checkout_date + ' 〜10:00</span></div>'
      + '  <div class="confirm-box__row"><span>宿泊数</span><span>' + params.nights + '泊</span></div>'
      + '  <div class="confirm-box__row"><span>宿泊人数</span><span>大人' + params.adults + '名 / 子供' + params.children + '名</span></div>'
      + '</div>'
      + '<div class="confirm-box__section">'
      + '  <h4>お支払い金額</h4>'
      + '  <div class="confirm-box__row"><span>宿泊料</span><span>¥' + params.subtotal + '</span></div>'
      + '  <div class="confirm-box__row"><span>消費税（10%）</span><span>¥' + params.tax + '</span></div>'
      + '  <div class="confirm-box__total">'
      + '    <span>合計（税込）</span>'
      + '    <span>¥' + params.total + '</span>'
      + '  </div>'
      + '</div>';

    document.getElementById('completeSummary').innerHTML = summaryHtml;
    goToStep(4);
  }

});
