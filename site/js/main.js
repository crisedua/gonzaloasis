/* ═══════════════════════════════════════════════════════════════════════════
   Asistente de IA — Modern Interactions & Scroll Animations
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Scroll Progress Bar ─────────────────────────────────────────────────
const progressBar = document.querySelector('.scroll-progress');
if (progressBar) {
  window.addEventListener('scroll', () => {
    const scrollTop = document.documentElement.scrollTop;
    const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
    progressBar.style.width = progress + '%';
  }, { passive: true });
}

// ── Scroll Reveal (multiple animation types) ────────────────────────────
const revealSelectors = '.reveal, .reveal-scale, .reveal-left, .reveal-right, .reveal-blur';
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

document.querySelectorAll(revealSelectors).forEach(el => observer.observe(el));

// ── Steps progress line animation ───────────────────────────────────────
const stepsEl = document.querySelector('.steps');
if (stepsEl) {
  const stepsObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        stepsObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  stepsObserver.observe(stepsEl);
}

// ── Nav scroll behavior ──────────────────────────────────────────────────
const nav = document.querySelector('.nav');
let lastScroll = 0;

window.addEventListener('scroll', () => {
  const scrollY = window.scrollY;
  if (scrollY > 50) {
    nav.classList.add('scrolled');
  } else {
    nav.classList.remove('scrolled');
  }
  lastScroll = scrollY;
}, { passive: true });

// ── Mobile menu ──────────────────────────────────────────────────────────
const menuToggle = document.querySelector('.menu-toggle');
const navLinks = document.querySelector('.nav-links');

if (menuToggle) {
  menuToggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
    const bars = menuToggle.querySelectorAll('span');
    if (navLinks.classList.contains('open')) {
      bars[0].style.transform = 'rotate(45deg) translate(5px, 5px)';
      bars[1].style.opacity = '0';
      bars[2].style.transform = 'rotate(-45deg) translate(5px, -5px)';
    } else {
      bars[0].style.transform = '';
      bars[1].style.opacity = '';
      bars[2].style.transform = '';
    }
  });

  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
      const bars = menuToggle.querySelectorAll('span');
      bars[0].style.transform = '';
      bars[1].style.opacity = '';
      bars[2].style.transform = '';
    });
  });
}

// ── Expandable skill cards ───────────────────────────────────────────────
document.querySelectorAll('.skill-card[data-expandable]').forEach(card => {
  card.addEventListener('click', () => {
    const wasExpanded = card.classList.contains('expanded');
    document.querySelectorAll('.skill-card.expanded').forEach(c => c.classList.remove('expanded'));
    if (!wasExpanded) card.classList.add('expanded');
  });
});

// ── Telegram mockup — typing indicator + message animation ──────────────
function animateMockup() {
  const messages = document.querySelectorAll('.tg-msg');
  const typing = document.querySelector('.tg-typing');
  let delay = 400;

  messages.forEach((msg, i) => {
    const isBot = msg.classList.contains('bot');

    // Show typing before bot messages
    if (isBot && typing) {
      const showTypingAt = delay;
      const hideTypingAt = delay + 600;
      setTimeout(() => { typing.classList.add('active'); }, showTypingAt);
      setTimeout(() => { typing.classList.remove('active'); }, hideTypingAt);
      delay = hideTypingAt + 100;
    }

    const showAt = isBot ? delay : delay;
    setTimeout(() => {
      msg.classList.add('animate-in');
    }, showAt);

    delay += isBot ? 700 : 500;
  });
}

// Trigger mockup animation when it enters viewport
const mockup = document.querySelector('.telegram-mockup');
if (mockup) {
  const mockupObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateMockup();
        mockupObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  mockupObserver.observe(mockup);
}

// ── Mouse glow effect on trust cards ─────────────────────────────────────
document.querySelectorAll('.trust-card').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    card.style.setProperty('--mouse-x', x + '%');
    card.style.setProperty('--mouse-y', y + '%');
  });
});

// ── 3D Tilt effect on skill cards ────────────────────────────────────────
document.querySelectorAll('.skill-card').forEach(card => {
  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -4;
    const rotateY = ((x - centerX) / centerX) * 4;
    card.style.transform = `translateY(-6px) perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  });

  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
  });
});

// ── Magnetic button effect ───────────────────────────────────────────────
document.querySelectorAll('.btn-primary').forEach(btn => {
  btn.addEventListener('mousemove', (e) => {
    const rect = btn.getBoundingClientRect();
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;
    btn.style.transform = `translate(${x * 0.15}px, ${y * 0.15}px) scale(1.02)`;
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.transform = '';
  });
});

// ── Parallax on hero orbs ────────────────────────────────────────────────
const heroOrbs = document.querySelectorAll('.hero-orb');
if (heroOrbs.length > 0) {
  window.addEventListener('mousemove', (e) => {
    const x = (e.clientX / window.innerWidth - 0.5) * 2;
    const y = (e.clientY / window.innerHeight - 0.5) * 2;
    heroOrbs.forEach((orb, i) => {
      const speed = (i + 1) * 15;
      orb.style.transform = `translate(${x * speed}px, ${y * speed}px)`;
    });
  }, { passive: true });
}

// ── Counter animation for stats ──────────────────────────────────────────
function animateCounters() {
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.dataset.count, 10);
    const duration = 1500;
    const start = performance.now();

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out quad
      const eased = 1 - (1 - progress) * (1 - progress);
      el.textContent = Math.round(target * eased);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

const counters = document.querySelectorAll('[data-count]');
if (counters.length > 0) {
  const counterObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounters();
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });
  counters.forEach(c => counterObserver.observe(c));
}

// ── Smooth scroll for anchor links ───────────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', (e) => {
    const target = document.querySelector(anchor.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// ── Generate CTA particles ───────────────────────────────────────────────
const particleContainer = document.querySelector('.cta-particles');
if (particleContainer) {
  for (let i = 0; i < 20; i++) {
    const particle = document.createElement('div');
    particle.classList.add('cta-particle');
    particle.style.left = Math.random() * 100 + '%';
    particle.style.animationDuration = (4 + Math.random() * 8) + 's';
    particle.style.animationDelay = Math.random() * 6 + 's';
    particle.style.width = (2 + Math.random() * 4) + 'px';
    particle.style.height = particle.style.width;
    particleContainer.appendChild(particle);
  }
}
