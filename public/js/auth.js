// Redirect to dashboard if already logged in
fetch('/api/auth/me')
  .then(r => { if (r.ok) window.location.href = '/dashboard.html'; });

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}

// Signup form
const signupForm = document.getElementById('signup-form');
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error);
      return;
    }

    window.location.href = '/dashboard.html';
  });
}

// Login form
const loginForm = document.getElementById('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error);
      return;
    }

    window.location.href = '/dashboard.html';
  });
}
