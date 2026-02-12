// ---- Feedback Modal (self-contained, appends to body) ----
(function () {
  // Inject HTML
  const html = `
    <button class="feedback-fab" id="feedback-fab" title="Send feedback">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      Feedback
    </button>
    <div class="feedback-overlay" id="feedback-overlay">
      <div class="feedback-modal">
        <div class="feedback-modal-header">
          <h3>Send Feedback</h3>
          <button class="feedback-close-btn" id="feedback-close">&times;</button>
        </div>
        <div class="feedback-modal-body">
          <form id="feedback-form">
            <div class="feedback-row">
              <div class="feedback-field">
                <label for="fb-category">Category *</label>
                <select id="fb-category" required>
                  <option value="">Select...</option>
                  <option value="feature">Feature Request</option>
                  <option value="bug">Bug Report</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div class="feedback-field">
                <label for="fb-severity">Severity *</label>
                <select id="fb-severity" required>
                  <option value="">Select...</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
            </div>
            <div class="feedback-field-full">
              <label for="fb-message">Message * <span style="font-weight:400;color:#999">(min 5 chars)</span></label>
              <textarea id="fb-message" placeholder="Describe the issue or suggestion..." required minlength="5" maxlength="4000"></textarea>
            </div>
            <div class="feedback-field-full">
              <label for="fb-screenshot">Screenshot <span style="font-weight:400;color:#999">(optional, max 2MB)</span></label>
              <input type="file" id="fb-screenshot" accept="image/png,image/jpeg,image/webp,image/gif">
            </div>
            <div class="feedback-submit-row">
              <button type="button" class="btn btn-secondary btn-small" id="feedback-cancel">Close</button>
              <button type="submit" class="btn btn-primary btn-small" id="feedback-submit">Send</button>
            </div>
          </form>
          <div class="feedback-status" id="feedback-status"></div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);

  const overlay = document.getElementById('feedback-overlay');
  const fab = document.getElementById('feedback-fab');
  const closeBtn = document.getElementById('feedback-close');
  const cancelBtn = document.getElementById('feedback-cancel');
  const form = document.getElementById('feedback-form');
  const statusEl = document.getElementById('feedback-status');
  const submitBtn = document.getElementById('feedback-submit');

  function openModal() {
    overlay.classList.add('open');
    statusEl.style.display = 'none';
    statusEl.className = 'feedback-status';
  }
  function closeModal() {
    overlay.classList.remove('open');
  }

  fab.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.style.display = 'none';

    const category = document.getElementById('fb-category').value;
    const severity = document.getElementById('fb-severity').value;
    const message = document.getElementById('fb-message').value.trim();
    const screenshotInput = document.getElementById('fb-screenshot');

    // Client-side validation
    if (!category) return showError('Please select a category.');
    if (!severity) return showError('Please select a severity.');
    if (message.length < 5) return showError('Message must be at least 5 characters.');
    if (message.length > 4000) return showError('Message too long (max 4000 characters).');

    // Check screenshot size
    if (screenshotInput.files[0] && screenshotInput.files[0].size > 2 * 1024 * 1024) {
      return showError('Screenshot too large (max 2MB).');
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending\u2026';

    try {
      const fd = new FormData();
      fd.append('category', category);
      fd.append('severity', severity);
      fd.append('message', message);
      fd.append('page_url', location.href);
      if (screenshotInput.files[0]) {
        fd.append('screenshot', screenshotInput.files[0]);
      }

      const res = await fetch('/api/feedback', {
        method: 'POST',
        body: fd
      });

      const data = await res.json();

      if (!res.ok) {
        showError(data.error || 'Failed to submit feedback.');
        return;
      }

      // Success
      statusEl.textContent = 'Thanks \u2014 feedback received!';
      statusEl.className = 'feedback-status success';
      statusEl.style.display = 'block';
      form.reset();

      setTimeout(() => { closeModal(); }, 2000);
    } catch (err) {
      showError('Something went wrong. Please try again.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send';
    }
  });

  function showError(msg) {
    statusEl.textContent = msg;
    statusEl.className = 'feedback-status error';
    statusEl.style.display = 'block';
  }
})();
