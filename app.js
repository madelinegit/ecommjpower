// Tab switching
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + target).classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
});

// ===== BEFORE & AFTER SLIDERS =====
document.querySelectorAll('.ba-slider').forEach(slider => {
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
});

// ===== LIGHTBOX =====
const lightbox = document.getElementById('lightbox');
const lbImg    = document.getElementById('lb-img');
const lbVideo  = document.getElementById('lb-video');
const lbClose  = document.getElementById('lb-close');

function openLightbox(src, isVideo) {
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
  lightbox.classList.remove('active');
  document.body.style.overflow = '';
  lbVideo.pause();
  lbVideo.src = '';
  lbImg.src   = '';
}

lbClose.addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// Touch swipe to close on mobile
let touchStartY = 0;
lightbox.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
lightbox.addEventListener('touchend', e => {
  if (Math.abs(e.changedTouches[0].clientY - touchStartY) > 80) closeLightbox();
}, { passive: true });

// ===== GALLERY ITEMS =====
function isVideoFile(name) {
  return /\.(mp4|mov|webm|ogg)$/i.test(name);
}

document.querySelectorAll('.gallery-item').forEach(item => {
  item.addEventListener('click', () => {
    // If the item already has real media loaded, open lightbox
    const img   = item.querySelector('.gallery-img');
    const video = item.querySelector('.gallery-video');

    if (video && video.src && video.getAttribute('data-loaded')) {
      openLightbox(video.src, true);
      return;
    }
    if (img && img.src && img.getAttribute('data-loaded')) {
      openLightbox(img.src, false);
      return;
    }

    // Otherwise let them pick a file
    const input = document.createElement('input');
    input.type  = 'file';
    input.accept = 'image/*,video/mp4,video/quicktime,video/webm';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      const placeholder = item.querySelector('.gallery-placeholder');
      if (placeholder) placeholder.style.display = 'none';

      if (isVideoFile(file.name)) {
        let v = item.querySelector('.gallery-video');
        if (!v) {
          v = document.createElement('video');
          v.className  = 'gallery-video';
          v.muted      = true;
          v.loop       = true;
          v.playsInline = true;
          v.autoplay   = true;
          item.appendChild(v);
        }
        v.src = url;
        v.setAttribute('data-loaded', '1');
        if (img) img.style.display = 'none';
      } else {
        if (img) {
          img.src = url;
          img.style.display   = 'block';
          img.setAttribute('data-loaded', '1');
        }
      }
    };
    input.click();
  });
});
