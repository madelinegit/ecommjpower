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

// Gallery image upload (click to replace)
document.querySelectorAll('.gallery-item').forEach(item => {
  item.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = evt => {
        const img = item.querySelector('.gallery-img');
        const placeholder = item.querySelector('.gallery-placeholder');
        if (img) {
          img.src = evt.target.result;
          img.style.display = 'block';
        }
        if (placeholder) placeholder.style.display = 'none';
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
});
