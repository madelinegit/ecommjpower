// ===== VIEW SWITCHING =====
// Art Gallery is the default landing view. A hash in the URL overrides it.
const VIEW_HASHES = {
  '#home-projects': 'home',
  '#home-services': 'home',   // legacy links
  '#art-gallery':   'art',
  '#art':           'art'
};

function setView(view, scroll) {
  document.querySelectorAll('.view-btn').forEach(b => {
    const on = b.dataset.view === view;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  const section = document.getElementById('tab-' + view);
  if (section) section.classList.add('active');
  if (scroll) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function viewFromHash() {
  return VIEW_HASHES[window.location.hash.toLowerCase()] || null;
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    // Keep the URL shareable without adding a history entry per tap.
    history.replaceState(null, '', view === 'home' ? '#home-projects' : '#art-gallery');
    setView(view, true);
  });
});

// Honor the hash on load, and on back/forward or an external #home-projects link.
setView(viewFromHash() || 'art', false);
window.addEventListener('hashchange', () => setView(viewFromHash() || 'art', true));

// ===== BEFORE & AFTER SLIDERS =====
// Extracted so sliders created later — inside the piece detail overlay —
// get the same behaviour as the ones present at page load.
function initSlider(slider) {
  if (slider.dataset.sliderReady) return;
  slider.dataset.sliderReady = '1';
  const after      = slider.querySelector('.ba-after');
  const beforeDiv  = slider.querySelector('.ba-before');
  const handle     = slider.querySelector('.ba-handle');
  let dragging = false;
  let startX   = 0;
  let moved    = false;

  function sliderPct() {
    return parseFloat(after.style.width) || 50;
  }

  function setPosition(clientX) {
    const rect = slider.getBoundingClientRect();
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.min(Math.max(pct, 0.02), 0.98);
    const p = (pct * 100).toFixed(1) + '%';
    after.style.width = p;
    handle.style.left = p;
  }

  function tryOpenLightbox(clientX) {
    const rect   = slider.getBoundingClientRect();
    const clickPct = ((clientX - rect.left) / rect.width) * 100;
    const side   = clickPct > sliderPct() ? after : beforeDiv;
    const img    = side.querySelector('.ba-img');
    if (img && img.src) openLightbox(img.src, false);
  }

  // Mouse
  slider.addEventListener('mousedown', e => {
    dragging = true; moved = false; startX = e.clientX;
    setPosition(e.clientX);
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    if (Math.abs(e.clientX - startX) > 6) moved = true;
    setPosition(e.clientX);
  });
  window.addEventListener('mouseup', e => {
    if (dragging && !moved) tryOpenLightbox(e.clientX);
    dragging = false; moved = false;
  });

  // Touch
  let touchStartX = 0;
  let touchMoved  = false;
  slider.addEventListener('touchstart', e => {
    dragging = true; touchMoved = false;
    touchStartX = e.touches[0].clientX;
    setPosition(e.touches[0].clientX);
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (!dragging) return;
    if (Math.abs(e.touches[0].clientX - touchStartX) > 10) touchMoved = true;
    setPosition(e.touches[0].clientX);
  }, { passive: true });
  window.addEventListener('touchend', e => {
    if (dragging && !touchMoved) tryOpenLightbox(e.changedTouches[0].clientX);
    dragging = false; touchMoved = false;
  });
}

document.querySelectorAll('.ba-slider').forEach(initSlider);

// Builds the drag-to-compare slider markup for a piece that has both a
// before and an after photo.
function buildSlider(beforeSrc, afterSrc, title) {
  const el = document.createElement('div');
  el.className = 'ba-slider';
  el.innerHTML =
    '<div class="ba-before">' +
      '<img class="ba-img" alt="' + title + ' before" src="' + beforeSrc + '" />' +
      '<span class="ba-tag ba-tag--before">Before</span>' +
    '</div>' +
    '<div class="ba-after">' +
      '<img class="ba-img" alt="' + title + ' after" src="' + afterSrc + '" />' +
      '<span class="ba-tag ba-tag--after">After</span>' +
    '</div>' +
    '<div class="ba-handle">' +
      '<div class="ba-handle-line"></div>' +
      '<div class="ba-handle-circle">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>' +
      '</div>' +
      '<div class="ba-handle-line"></div>' +
    '</div>';
  return el;
}

// ===== LIGHTBOX =====
const lightbox = document.getElementById('lightbox');
const lbImg    = document.getElementById('lb-img');
const lbVideo  = document.getElementById('lb-video');
const lbClose  = document.getElementById('lb-close');

function openLightbox(src, isVideo) {
  // The piece page reuses this script for its slider but has no lightbox.
  if (!lightbox) return;
  if (isVideo) {
    lbVideo.src = src;
    lbVideo.style.display = 'block';
    lbImg.style.display   = 'none';
    lbVideo.play();
  } else {
    lbImg.src             = src;
    lbImg.style.display   = 'block';
    lbVideo.style.display = 'none';
    lbVideo.pause();
    lbVideo.src = '';
  }
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove('active');
  document.body.style.overflow = '';
  lbVideo.pause();
  lbVideo.src = '';
  lbImg.src   = '';
}

if (lightbox && lbClose) {
  lbClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
}

// Touch swipe to close on mobile
let touchStartY = 0;
if (lightbox) {
  lightbox.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  lightbox.addEventListener('touchend', e => {
    if (Math.abs(e.changedTouches[0].clientY - touchStartY) > 80) closeLightbox();
  }, { passive: true });
}

// ===== PIECE DETAIL =====
// Tiles are real links, so they work with JavaScript off and are crawlable.
// When JS is available they open in place instead, which is far quicker on a
// phone than a full page load.
const PIECES = window.__PIECES__ || {};
const detail = document.getElementById('detail');

function openDetail(id, push) {
  const piece = PIECES[id];
  if (!piece || !detail) return false;

  detail.querySelector('.detail-title').textContent = piece.title;

  const priceEl = detail.querySelector('.detail-price');
  priceEl.textContent = piece.price || '';
  priceEl.style.display = piece.price ? 'block' : 'none';

  const descEl = detail.querySelector('.detail-desc');
  descEl.textContent = piece.description || '';
  descEl.style.display = piece.description ? 'block' : 'none';

  const feat = detail.querySelector('.detail-features');
  feat.innerHTML = '';
  (piece.features || []).forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    feat.appendChild(li);
  });
  feat.style.display = (piece.features || []).length ? 'block' : 'none';

  const shots = detail.querySelector('.detail-shots');
  shots.innerHTML = '';

  // The comparison leads, because it is the most persuasive thing here.
  if (piece.before && piece.after) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-ba';
    const slider = buildSlider(piece.before, piece.after, piece.title);
    wrap.appendChild(slider);
    const hint = document.createElement('p');
    hint.className = 'detail-ba-hint';
    hint.textContent = 'Drag to compare';
    wrap.appendChild(hint);
    shots.appendChild(wrap);
    initSlider(slider);
  }

  piece.images.forEach((src, i) => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = piece.title + (piece.images.length > 1 ? ' — photo ' + (i + 1) : '');
    img.className = 'detail-shot';
    if (i > 0) img.loading = 'lazy';
    shots.appendChild(img);
  });

  const cta = detail.querySelector('.detail-cta');
  cta.href = piece.sms;
  cta.textContent = piece.category === 'home' ? 'Get a quote like this' : 'Ask about this piece';

  detail.querySelector('.detail-full').href = piece.href;

  detail.classList.add('active');
  document.body.style.overflow = 'hidden';
  shots.scrollTop = 0;

  if (push) history.pushState({ piece: id }, '', piece.href);
  return true;
}

function closeDetail(pop) {
  if (!detail) return;
  detail.classList.remove('active');
  document.body.style.overflow = '';
  if (!pop && history.state && history.state.piece) history.back();
}

document.querySelectorAll('.tile').forEach(tile => {
  tile.addEventListener('click', e => {
    // Let modified clicks open a real tab.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    if (openDetail(tile.dataset.piece, true)) e.preventDefault();
  });
});

if (detail) {
  detail.querySelector('.detail-close').addEventListener('click', () => closeDetail(false));
  detail.addEventListener('click', e => { if (e.target === detail) closeDetail(false); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && detail.classList.contains('active')) closeDetail(false);
  });
  window.addEventListener('popstate', e => {
    if (e.state && e.state.piece) openDetail(e.state.piece, false);
    else closeDetail(true);
  });
}
