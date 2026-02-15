// ---- Dark Mode Toggle ----
// Applies saved preference immediately to prevent flash
(function() {
  var saved = localStorage.getItem('meetingmind-theme');
  if (saved === 'dark') document.body.classList.add('dark-mode');
})();

// Bind click handler to existing #theme-toggle button in navbar
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  btn.addEventListener('click', function() {
    document.body.classList.toggle('dark-mode');
    var isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('meetingmind-theme', isDark ? 'dark' : 'light');
  });
});
