// ---- Dark Mode Toggle ----
// Applies saved preference immediately to prevent flash
(function() {
  var saved = localStorage.getItem('meetingmind-theme');
  if (saved === 'dark') document.body.classList.add('dark-mode');
})();

// Inject toggle button into navbar after the logo
document.addEventListener('DOMContentLoaded', function() {
  var logo = document.querySelector('.navbar .logo');
  if (!logo) return;

  var btn = document.createElement('button');
  btn.className = 'theme-toggle';
  btn.setAttribute('aria-label', 'Toggle dark mode');
  btn.setAttribute('title', 'Toggle dark mode');
  btn.innerHTML = '<span class="icon-sun">&#9728;</span><span class="icon-moon">&#9790;</span>';

  // Insert after logo
  logo.parentNode.insertBefore(btn, logo.nextSibling);

  btn.addEventListener('click', function() {
    document.body.classList.toggle('dark-mode');
    var isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('meetingmind-theme', isDark ? 'dark' : 'light');
  });
});
