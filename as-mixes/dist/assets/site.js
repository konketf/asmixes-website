const toggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() {
  navigation.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}
toggle.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('open', open);
});
navigation.addEventListener('click', event => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation.classList.contains('open')) {
    closeMenu();
    toggle.focus();
  }
});
document.querySelectorAll('[data-service]').forEach(link => {
  link.addEventListener('click', () => {
    document.querySelector('#service').value = link.dataset.service;
  });
});
document.querySelector('#contact-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const subject = `Project enquiry: ${data.get('service')} — ${data.get('name')}`;
  const projectDetails = [
    data.get('trackCount') && `Audio tracks per mix: ${data.get('trackCount')}`,
    data.get('deadline') && `Deadline: ${data.get('deadline')}`,
  ].filter(Boolean);
  const body = [`Name / band: ${data.get('name')}`, `Email: ${data.get('email')}`, `Service: ${data.get('service')}`, ...projectDetails, '', data.get('message')].join('\n');
  window.location.href = `mailto:hello@example.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.querySelector('#form-status').textContent = 'Your email draft is ready in your email app. If it did not open, email hello@example.com directly. This demo address must be replaced before launch.';
});
