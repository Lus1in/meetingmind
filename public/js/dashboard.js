// ---- Auth Guard ----
let currentUser = null;

async function checkAuth() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/login.html';
    return;
  }
  currentUser = await res.json();
  document.getElementById('user-email').textContent = currentUser.email;
}

checkAuth().then(loadMeetings);

// ---- Logout ----
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// ---- Extract Action Items ----
const extractBtn = document.getElementById('extract-btn');
const notesInput = document.getElementById('notes-input');
const resultsDiv = document.getElementById('results');

let lastExtracted = null;

extractBtn.addEventListener('click', async () => {
  const notes = notesInput.value.trim();
  if (!notes) {
    alert('Please paste your meeting notes first.');
    return;
  }

  // Loading state
  extractBtn.disabled = true;
  extractBtn.innerHTML = '<span class="spinner"></span>Extracting...';

  try {
    const res = await fetch('/api/meetings/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });

    if (!res.ok) {
      const data = await res.json();
      if (res.status === 429) {
        showLimitMessage(data.message);
      } else {
        alert(data.error || 'Extraction failed');
      }
      return;
    }

    lastExtracted = await res.json();
    renderResults(lastExtracted);
  } catch (err) {
    alert('Something went wrong. Please try again.');
  } finally {
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Action Items';
  }
});

// ---- Render Results ----
function renderResults(data) {
  const tbody = document.getElementById('action-items-body');
  tbody.innerHTML = '';

  data.action_items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td>`;
    tbody.appendChild(tr);
  });

  document.getElementById('email-content').textContent = data.follow_up_email;
  resultsDiv.style.display = 'block';
  resultsDiv.scrollIntoView({ behavior: 'smooth' });
}

// ---- Copy Email ----
document.getElementById('copy-email-btn').addEventListener('click', () => {
  const text = document.getElementById('email-content').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-email-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  });
});

// ---- Save Meeting ----
document.getElementById('save-btn').addEventListener('click', async () => {
  const notes = notesInput.value.trim();
  if (!notes || !lastExtracted) return;

  const res = await fetch('/api/meetings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw_notes: notes, action_items: lastExtracted })
  });

  if (res.ok) {
    notesInput.value = '';
    resultsDiv.style.display = 'none';
    lastExtracted = null;
    loadMeetings();
  }
});

// ---- Discard ----
document.getElementById('discard-btn').addEventListener('click', () => {
  resultsDiv.style.display = 'none';
  lastExtracted = null;
});

// ---- Load Past Meetings ----
async function loadMeetings() {
  const res = await fetch('/api/meetings');
  if (!res.ok) return;

  const meetings = await res.json();
  const list = document.getElementById('meetings-list');

  if (meetings.length === 0) {
    list.innerHTML = '<div class="empty-state">No meetings yet. Paste your first notes above!</div>';
    return;
  }

  list.innerHTML = meetings.map(m => {
    const date = new Date(m.created_at + 'Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const preview = m.raw_notes.length > 120
      ? m.raw_notes.substring(0, 120) + '...'
      : m.raw_notes;

    const itemsRows = m.action_items.action_items.map(item =>
      `<tr><td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td></tr>`
    ).join('');

    return `
      <div class="meeting-card">
        <div class="meeting-card-header">
          <span class="date">${date}</span>
          <button class="btn btn-danger btn-small" onclick="deleteMeeting(${m.id})">Delete</button>
        </div>
        <div class="notes-preview">${escapeHtml(preview)}</div>
        <details>
          <summary>View action items & email</summary>
          <table class="action-items-table" style="margin-top:12px">
            <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th></tr></thead>
            <tbody>${itemsRows}</tbody>
          </table>
          <h4 style="margin:12px 0 8px">Follow-up Email</h4>
          <div class="email-box">${escapeHtml(m.action_items.follow_up_email)}</div>
        </details>
      </div>
    `;
  }).join('');
}

// ---- Delete Meeting ----
async function deleteMeeting(id) {
  if (!confirm('Delete this meeting?')) return;

  const res = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
  if (res.ok) loadMeetings();
}

// ---- Limit Reached Banner ----
function showLimitMessage(message) {
  let banner = document.getElementById('limit-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'limit-banner';
    banner.className = 'limit-banner';
    const inputSection = document.querySelector('.notes-input');
    inputSection.parentNode.insertBefore(banner, inputSection.nextSibling);
  }
  banner.textContent = message;
  banner.style.display = 'block';
}

// ---- Utility ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
