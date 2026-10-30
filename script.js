document.addEventListener('DOMContentLoaded', () => {
  const menuToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');
  menuToggle?.addEventListener('click', () => {
    navLinks?.classList.toggle('nav-links-open');
    menuToggle.classList.toggle('nav-toggle-open');
  });

  document.querySelectorAll('.nav-links > li.has-megamenu > a.megamenu-trigger').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const parentLi = link.parentElement;
      document.querySelectorAll('.nav-links > li.megamenu-open').forEach((li) => {
        if (li !== parentLi) li.classList.remove('megamenu-open');
      });
      parentLi.classList.toggle('megamenu-open');
    });
  });

  document.addEventListener('click', (e) => {
    document.querySelectorAll('.nav-links > li.has-megamenu').forEach((li) => {
      if (!li.contains(e.target)) li.classList.remove('megamenu-open');
    });
  });

  // Hero split carousel: shows 2 panels at a time, cycling through pairs
  const heroSplit = document.getElementById('hero-split');
  if (heroSplit) {
    const panels = Array.from(heroSplit.querySelectorAll('.hero-panel'));
    const pairCount = Math.ceil(panels.length / 2);
    let pair = 0;
    let timer;

    function renderPanel(el) {
      el.innerHTML = `
        <div class="hero-panel-overlay">
          <h1>${el.dataset.title}</h1>
          <p>${el.dataset.text}</p>
          <a href="${el.dataset.link}" class="btn-cta btn-hero">${el.dataset.cta}</a>
        </div>`;
    }

    function showPair(index) {
      pair = (index + pairCount) % pairCount;
      panels.forEach((el, i) => {
        const show = i === pair * 2 || i === pair * 2 + 1;
        el.hidden = !show;
        if (show) renderPanel(el);
      });
    }
    function nextPair() { showPair(pair + 1); }
    function prevPair() { showPair(pair - 1); }
    function resetTimer() {
      clearInterval(timer);
      timer = setInterval(nextPair, 7000);
    }

    heroSplit.querySelector('.hero-arrow-next')?.addEventListener('click', () => { nextPair(); resetTimer(); });
    heroSplit.querySelector('.hero-arrow-prev')?.addEventListener('click', () => { prevPair(); resetTimer(); });

    showPair(0);
    resetTimer();
  }

  // Cart / account icons (demo only — no real cart/account system)
  document.getElementById('cart-btn')?.addEventListener('click', () => {
    alert('Your cart is empty (demo only).');
  });
  document.getElementById('account-btn')?.addEventListener('click', () => {
    alert('Account sign-in isn\'t available in this concept demo.');
  });

  // WhatsApp floating button
  if (!document.querySelector('.whatsapp-float')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'whatsapp-float';
    btn.setAttribute('aria-label', 'Chat on WhatsApp');
    btn.innerHTML = '<svg viewBox="0 0 32 32" width="28" height="28" fill="#fff"><path d="M16.02 3C9.4 3 4 8.4 4 15.02c0 2.3.64 4.44 1.76 6.27L4 29l7.9-1.72a11.95 11.95 0 0 0 4.12.73h.01c6.62 0 12.02-5.4 12.02-12.02C28.05 8.4 22.65 3 16.02 3zm0 21.9h-.01a9.9 9.9 0 0 1-5.05-1.38l-.36-.21-3.76.82.82-3.67-.24-.38a9.86 9.86 0 0 1-1.5-5.26c0-5.47 4.45-9.92 9.91-9.92 2.65 0 5.14 1.03 7.01 2.9a9.84 9.84 0 0 1 2.9 7.02c0 5.47-4.45 9.92-9.72 9.92v.16zm5.44-7.43c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.78-1.47-1.75-1.65-2.05-.17-.3-.02-.46.13-.6.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.6-.91-2.2-.24-.57-.49-.5-.67-.5h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.47 0 1.46 1.06 2.87 1.21 3.07.15.2 2.09 3.2 5.08 4.48.71.3 1.26.49 1.69.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/></svg>';
    btn.addEventListener('click', () => {
      alert('WhatsApp chat isn\'t available in this concept demo.');
    });
    document.body.appendChild(btn);
  }
});
