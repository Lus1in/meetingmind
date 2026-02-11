// Redirect to dashboard if already logged in
fetch('/api/auth/me')
  .then(r => { if (r.ok) window.location.href = '/dashboard.html'; });

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}

// Show OAuth error from redirect query params
const urlParams = new URLSearchParams(window.location.search);
const oauthError = urlParams.get('error');
if (oauthError) {
  const messages = {
    google_denied: 'Google login was cancelled. Please try again.',
    google_failed: 'Google login failed. Please try again.',
    apple_denied: 'Apple login was cancelled. Please try again.',
    apple_failed: 'Apple login failed. Please try again.',
    apple_no_email: 'Apple did not share your email. Please try again or use email signup.',
    email_unverified: 'Your email is not verified with this provider. Please verify it first.',
    invalid_state: 'Login session expired. Please try again.'
  };
  showError(messages[oauthError] || 'Login failed. Please try again.');
  // Clean the URL
  window.history.replaceState({}, '', window.location.pathname);
}

// Signup form
const signupForm = document.getElementById('signup-form');
if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    if (!email) { showError('Please enter your email address.'); return; }
    if (password.length < 8) { showError('Password must be at least 8 characters.'); return; }
    if (password !== confirmPassword) { showError('Passwords do not match.'); return; }

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
