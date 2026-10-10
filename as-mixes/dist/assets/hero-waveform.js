(() => {
  'use strict';
  const canvas = document.querySelector('.hero-waveform');
  const context = canvas?.getContext('2d');
  if (!context) return;

  // All tuning lives here. The envelope stays fixed; only its fine detail drifts.
  const settings = { height: .28, speed: .16, lineWidth: .8, glow: 7, reflectionOpacity: .55, fps: 30 };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const compact = matchMedia('(max-width: 900px)');
  let width = 0, height = 0, frame = 0, elapsed = 0, previous = 0;
  let inView = true;

  function draw(time) {
    context.clearRect(0, 0, width, height);
    const accent = getComputedStyle(canvas).color;
    const fade = context.createLinearGradient(0, 0, width, 0);
    fade.addColorStop(0, 'transparent');
    fade.addColorStop(.22, accent);
    fade.addColorStop(.78, accent);
    fade.addColorStop(1, 'transparent');
    context.strokeStyle = fade;
    context.lineWidth = settings.lineWidth;
    context.lineJoin = 'round';
    context.shadowColor = accent;
    context.shadowBlur = settings.glow;
    // Mirrored, band-limited contours suggest a recorded waveform without bars.
    // A smooth central envelope and quieter shoulders keep the edges restrained.
    for (const side of [-1, 1]) {
      context.beginPath();
      context.globalAlpha = side === 1 ? settings.reflectionOpacity : 1;
      for (let x = 0; x <= width; x += 1) {
        const u = x / width;
        const envelope = Math.pow(Math.sin(Math.PI * u), 2.8) * Math.exp(-Math.pow((u - .5) * 2.3, 2));
        const detail = Math.abs(
          .53 * Math.sin(u * 157 + time) +
          .28 * Math.sin(u * 251 - time * .7) +
          .19 * Math.sin(u * 89 + time * .4)
        );
        const amplitude = height * settings.height * envelope * (.12 + detail * .88);
        const y = height / 2 + side * amplitude;
        if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
      }
      context.stroke();
    }
    context.globalAlpha = 1;
  }

  function tick(now) {
    frame = requestAnimationFrame(tick);
    if (!previous) previous = now;
    const delta = now - previous;
    if (delta < 1000 / settings.fps) return;
    elapsed += Math.min(delta, 100) / 1000;
    previous = now;
    draw(elapsed * settings.speed);
  }

  function sync() {
    cancelAnimationFrame(frame);
    frame = 0; previous = 0;
    if (compact.matches || document.hidden || !inView || !width) return;
    draw(elapsed * settings.speed);
    if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width; height = bounds.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    sync();
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(entries => {
    inView = entries[0].isIntersecting;
    sync();
  }).observe(canvas);
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  compact.addEventListener('change', resize);
  resize();
})();
