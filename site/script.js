/* ========================================
   EN — Interactions
   ======================================== */

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
  if (header) {
    const updateHeader = () => {
      header.classList.toggle('has-bg', window.scrollY > 80);
    };
    window.addEventListener('scroll', updateHeader, { passive: true });
    updateHeader();
  }


  /* ---------- Side Panel ---------- */
  const menuBtn = document.getElementById('menuBtn');
  const panel = document.getElementById('sidePanel');
  const panelClose = document.getElementById('panelClose');
  const panelOverlay = document.getElementById('panelOverlay');

  function openPanel() {
    panel.classList.add('is-open');
    panelOverlay.classList.add('is-visible');
    menuBtn.classList.add('is-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    panelClose.focus();
  }

  function closePanel() {
    panel.classList.remove('is-open');
    panelOverlay.classList.remove('is-visible');
    menuBtn.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  menuBtn.addEventListener('click', () => {
    panel.classList.contains('is-open') ? closePanel() : openPanel();
  });
  panelClose.addEventListener('click', function () { closePanel(); menuBtn.focus(); });
  panelOverlay.addEventListener('click', closePanel);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('is-open')) {
      closePanel();
      menuBtn.focus();
    }
  });

  document.querySelectorAll('.side-panel__link').forEach((link) => {
    link.addEventListener('click', () => closePanel());
  });


  /* ---------- Hero Slideshow ---------- */
  const slides = document.querySelectorAll('.hero__slide');
  let current = 0;
  const total = slides.length;

  if (total > 1) {
    setInterval(() => {
      slides[current].classList.remove('is-active');
      current = (current + 1) % total;
      slides[current].classList.add('is-active');
    }, 8000);
  }


  /* ---------- Gallery (horizontal scroll + lightbox) ---------- */
  const track = document.getElementById('galleryTrack');
  const prevBtn = document.getElementById('galleryPrev');
  const nextBtn = document.getElementById('galleryNext');
  const counter = document.getElementById('galleryCounter');

  if (track && prevBtn && nextBtn && counter) {
    const items = track.querySelectorAll('.gallery__item');
    const totalItems = items.length;

    function getScrollAmount() {
      const first = track.querySelector('.gallery__item');
      if (!first) return 300;
      return first.offsetWidth + 16;
    }

    function updateCounter() {
      const scrollPos = track.scrollLeft;
      const itemW = getScrollAmount();
      const visibleCount = Math.round(track.offsetWidth / itemW);
      const idx = Math.min(Math.round(scrollPos / itemW) + visibleCount, totalItems);
      counter.textContent = String(Math.max(idx, 1)).padStart(2, '0') + ' / ' + String(totalItems).padStart(2, '0');
    }

    prevBtn.addEventListener('click', () => {
      track.scrollBy({ left: -getScrollAmount(), behavior: 'smooth' });
    });

    nextBtn.addEventListener('click', () => {
      track.scrollBy({ left: getScrollAmount(), behavior: 'smooth' });
    });

    track.addEventListener('scroll', updateCounter, { passive: true });
    window.addEventListener('resize', updateCounter, { passive: true });
    updateCounter();


    /* ---------- Lightbox ---------- */
    const lightbox = document.createElement('div');
    lightbox.className = 'lightbox';
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', '写真の拡大表示');
    lightbox.innerHTML = '<button type="button" class="lightbox__close" aria-label="閉じる">×</button>'
      + '<span class="lightbox__counter"></span>'
      + '<img class="lightbox__img" src="" alt="">'
      + '<p class="lightbox__caption"></p>'
      + '<button type="button" class="lightbox__nav lightbox__nav--prev" aria-label="前の写真">‹</button>'
      + '<button type="button" class="lightbox__nav lightbox__nav--next" aria-label="次の写真">›</button>';
    document.body.appendChild(lightbox);

    const lbImg = lightbox.querySelector('.lightbox__img');
    const lbCaption = lightbox.querySelector('.lightbox__caption');
    const lbCounter = lightbox.querySelector('.lightbox__counter');
    let lbIndex = 0;
    let lastFocus = null;

    function renderLb() {
      const btn = items[lbIndex].querySelector('.gallery__zoom');
      lbImg.src = btn.dataset.src;
      lbImg.alt = btn.dataset.alt;
      lbCaption.textContent = btn.dataset.alt;
      lbCounter.textContent = String(lbIndex + 1).padStart(2, '0') + ' / ' + String(totalItems).padStart(2, '0');
    }

    function openLb(i) {
      lbIndex = i;
      lastFocus = document.activeElement;
      renderLb();
      lightbox.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      lightbox.querySelector('.lightbox__close').focus();
    }

    function closeLb() {
      lightbox.classList.remove('is-open');
      document.body.style.overflow = '';
      if (lastFocus) lastFocus.focus();
    }

    function stepLb(d) {
      lbIndex = (lbIndex + d + totalItems) % totalItems;
      renderLb();
    }

    items.forEach((item, i) => {
      const z = item.querySelector('.gallery__zoom');
      if (z) z.addEventListener('click', () => openLb(i));
    });

    lightbox.querySelector('.lightbox__close').addEventListener('click', closeLb);
    lightbox.querySelector('.lightbox__nav--prev').addEventListener('click', () => stepLb(-1));
    lightbox.querySelector('.lightbox__nav--next').addEventListener('click', () => stepLb(1));

    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLb();
    });

    document.addEventListener('keydown', (e) => {
      if (!lightbox.classList.contains('is-open')) return;
      if (e.key === 'Escape') closeLb();
      if (e.key === 'ArrowLeft') stepLb(-1);
      if (e.key === 'ArrowRight') stepLb(1);
    });
  }


  /* ---------- Smooth Scroll for Anchors ---------- */
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', (e) => {
      const href = anchor.getAttribute('href');
      if (href === '#') {
        /* # のみのリンク（ロゴ等）は先頭へスクロール */
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });


  /* ---------- Terms dialog ---------- */
  const termsDialog = document.getElementById('termsDialog');
  document.querySelectorAll('.js-terms-link').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      if (termsDialog && typeof termsDialog.showModal === 'function') {
        termsDialog.showModal();
      }
    });
  });
  const termsClose = document.getElementById('termsClose');
  if (termsClose) termsClose.addEventListener('click', function () { termsDialog.close(); });

});
