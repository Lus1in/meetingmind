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

  // Show plan badge
  const badge = document.getElementById('plan-badge');
  const planLabels = { free: 'Free', ltd: 'LTD', fltd: 'FLTD', sub_basic: 'Basic', sub_pro: 'Pro' };
  if (currentUser.is_lifetime) {
    badge.textContent = planLabels[currentUser.plan] || currentUser.plan;
    badge.className = 'plan-badge lifetime';
    badge.style.display = 'inline-block';
  } else if (currentUser.plan !== 'free') {
    badge.textContent = planLabels[currentUser.plan] || currentUser.plan;
    badge.className = 'plan-badge';
    badge.style.display = 'inline-block';
  }

  // Show admin link if user is admin
  if (currentUser.isAdmin) {
    document.getElementById('admin-link').style.display = 'inline-block';
  }

  // Show dev banner when mock mode is active
  if (currentUser.mock_mode) {
    let banner = document.getElementById('mock-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'mock-banner';
      banner.className = 'mock-banner';
      banner.textContent = 'Dev mode — transcription and extraction use mock data';
      document.querySelector('.container').prepend(banner);
    }
  }
}

checkAuth().then(loadMeetings).then(function() {
  // Auto-open meeting detail if ?view=ID is in the URL (used by live meeting redirect)
  var params = new URLSearchParams(window.location.search);
  var viewId = params.get('view');
  if (viewId) {
    history.replaceState(null, '', '/dashboard.html');
    viewMeeting(parseInt(viewId), true);
  }
});

// ---- Logout ----
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// ---- Upload Audio ----
const uploadBtn = document.getElementById('upload-btn');
const audioFileInput = document.getElementById('audio-file');
const uploadStatus = document.getElementById('upload-status');

uploadBtn.addEventListener('click', async () => {
  const file = audioFileInput.files[0];
  if (!file) {
    uploadStatus.textContent = 'Please select an audio file first.';
    uploadStatus.className = 'upload-status error';
    return;
  }

  // Client-side file size check (100 MB)
  var maxSize = 100 * 1024 * 1024;
  if (file.size > maxSize) {
    uploadStatus.textContent = 'File too large. Maximum size is 100 MB.';
    uploadStatus.className = 'upload-status error';
    return;
  }

  const title = document.getElementById('upload-title').value.trim();
  const formData = new FormData();
  formData.append('audio', file);
  if (title) formData.append('title', title);

  uploadBtn.disabled = true;
  uploadStatus.textContent = 'Uploading\u2026';
  uploadStatus.className = 'upload-status uploading';

  try {
    uploadStatus.textContent = 'Transcribing\u2026';
    uploadStatus.className = 'upload-status transcribing';

    const res = await fetch('/api/meetings/upload', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json();
      if (res.status === 403 && errData.error === 'meeting_limit') {
        showLimitMessage(errData.message);
      } else {
        let msg = errData.error || 'Upload failed';
        if (res.status === 400 && msg.includes('file type')) {
          msg = 'Unsupported format. Please use mp3, wav, or m4a files.';
        } else if (res.status === 400 && msg.includes('too large')) {
          msg = 'File is too large. Maximum size is 25 MB.';
        } else if (res.status >= 500) {
          msg = 'Transcription failed. The file may be corrupted or too short. Please try a different recording.';
        }
        uploadStatus.textContent = msg;
        uploadStatus.className = 'upload-status error';
      }
      return;
    }

    const data = await res.json();

    uploadStatus.textContent = 'Saved!';
    uploadStatus.className = 'upload-status saved';

    // Clear inputs
    audioFileInput.value = '';
    document.getElementById('upload-title').value = '';

    // Refresh meetings list, then navigate to the new transcript
    await loadMeetings();
    viewMeeting(data.id, true);

    // Clear status after a few seconds
    setTimeout(() => {
      uploadStatus.textContent = '';
      uploadStatus.className = 'upload-status';
    }, 3000);
  } catch (err) {
    uploadStatus.textContent = 'Something went wrong. Please try again.';
    uploadStatus.className = 'upload-status error';
  } finally {
    uploadBtn.disabled = false;
  }
});

// ---- Extract Action Items ----
const extractBtn = document.getElementById('extract-btn');
const notesInput = document.getElementById('notes-input');
const resultsDiv = document.getElementById('results');

let lastExtracted = null;
let currentMeetingId = null;
let originalTranscript = null;

extractBtn.addEventListener('click', async () => {
  const notes = notesInput.value.trim();
  if (!notes) {
    var emptyMsg = document.getElementById('extract-empty-msg');
    if (emptyMsg) emptyMsg.style.display = 'block';
    setTimeout(function() { if (emptyMsg) emptyMsg.style.display = 'none'; }, 5000);
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
      if (res.status === 429 || (data.error === 'limit_reached')) {
        showLimitMessage(data.message || data.error);
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

// ---- Render Results (editable before save) ----
function renderResults(data) {
  // Summary
  var summarySection = document.getElementById('results-summary-section');
  var summaryEl = document.getElementById('results-summary');
  if (data.summary) {
    summaryEl.textContent = data.summary;
    summarySection.style.display = 'block';
  } else {
    summarySection.style.display = 'none';
  }

  const tbody = document.getElementById('action-items-body');
  const table = tbody.closest('table');
  tbody.innerHTML = '';

  // Add delete column header if not present
  const thead = table.querySelector('thead tr');
  if (!thead.querySelector('.action-col')) {
    const th = document.createElement('th');
    th.className = 'action-col';
    th.style.width = '40px';
    thead.appendChild(th);
  }

  data.action_items.forEach(item => {
    tbody.appendChild(createEditableRow(item, 'extract'));
  });
  table.classList.add('editable');

  // Add item button
  let addBtn = document.getElementById('add-extract-item-btn');
  if (!addBtn) {
    addBtn = document.createElement('button');
    addBtn.id = 'add-extract-item-btn';
    addBtn.className = 'btn btn-secondary btn-small add-item-btn';
    addBtn.textContent = '+ Add item';
    table.after(addBtn);
  }
  addBtn.style.display = 'inline-block';

  // Open Questions
  var questionsSection = document.getElementById('results-questions-section');
  var questionsList = document.getElementById('results-questions');
  var questions = data.open_questions || [];
  if (questions.length > 0) {
    questionsList.innerHTML = questions.map(function(q) { return '<li>' + escapeHtml(q) + '</li>'; }).join('');
    questionsSection.style.display = 'block';
  } else {
    questionsSection.style.display = 'none';
  }

  // Proposed Solutions
  var solutionsSection = document.getElementById('results-solutions-section');
  var solutionsList = document.getElementById('results-solutions');
  var solutions = data.proposed_solutions || [];
  if (solutions.length > 0) {
    solutionsList.innerHTML = solutions.map(function(s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('');
    solutionsSection.style.display = 'block';
  } else {
    solutionsSection.style.display = 'none';
  }

  // Follow-up email as editable textarea
  const emailContainer = document.getElementById('email-content');
  emailContainer.innerHTML = '';
  const emailTextarea = document.createElement('textarea');
  emailTextarea.id = 'extract-email-textarea';
  emailTextarea.value = data.follow_up_email || '';
  emailTextarea.style.cssText = 'width:100%;min-height:120px;padding:12px;border:1px solid #d0d0d0;border-radius:6px;font-size:0.9rem;font-family:inherit;line-height:1.7;resize:vertical;box-sizing:border-box;';
  emailContainer.appendChild(emailTextarea);

  // Update email buttons (always visible so user can type an email and use them)
  updateExtractEmailLinks(data.follow_up_email || '');
  document.getElementById('extract-email-actions').style.display = 'flex';

  // Live sync: any edit to inputs/textarea refreshes lastExtracted + email links
  emailTextarea.addEventListener('input', liveSync);
  tbody.addEventListener('input', liveSync);

  resultsDiv.style.display = 'block';
  resultsDiv.scrollIntoView({ behavior: 'smooth' });
}

function liveSync() {
  syncExtractedFromInputs();
  if (lastExtracted) {
    updateExtractEmailLinks(lastExtracted.follow_up_email);
  }
}

function createEditableRow(item, prefix) {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input type="text" class="${prefix}-task"></td>` +
    `<td><input type="text" class="${prefix}-owner"></td>` +
    `<td><input type="text" class="${prefix}-deadline"></td>` +
    `<td><button class="delete-row-btn" title="Remove">&times;</button></td>`;
  tr.querySelector(`.${prefix}-task`).value = item.task || '';
  tr.querySelector(`.${prefix}-owner`).value = item.owner || '';
  tr.querySelector(`.${prefix}-deadline`).value = item.deadline || '';
  return tr;
}

function updateExtractEmailLinks(emailText) {
  const subject = encodeURIComponent('Meeting follow-up');
  const body = encodeURIComponent(emailText);
  document.getElementById('extract-gmail-btn').href =
    `https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`;
  document.getElementById('extract-outlook-btn').href =
    `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;
}

// Sync lastExtracted from current extract-result inputs
function syncExtractedFromInputs() {
  const rows = document.querySelectorAll('#action-items-body tr');
  const items = [];
  rows.forEach(tr => {
    const task = tr.querySelector('.extract-task');
    if (task && task.value.trim()) {
      items.push({
        task: task.value.trim(),
        owner: (tr.querySelector('.extract-owner') || {}).value || '',
        deadline: (tr.querySelector('.extract-deadline') || {}).value || ''
      });
    }
  });
  const emailTa = document.getElementById('extract-email-textarea');
  if (lastExtracted) {
    lastExtracted.action_items = items;
    lastExtracted.follow_up_email = emailTa ? emailTa.value : '';
  }
}

// Event delegation for extract result table
document.getElementById('action-items-body').addEventListener('click', (e) => {
  if (e.target.classList.contains('delete-row-btn')) {
    e.target.closest('tr').remove();
    liveSync();
  }
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'add-extract-item-btn') {
    const tbody = document.getElementById('action-items-body');
    tbody.appendChild(createEditableRow({ task: '', owner: '', deadline: '' }, 'extract'));
  }
});

// ---- Copy Email ----
document.getElementById('copy-email-btn').addEventListener('click', () => {
  const textarea = document.getElementById('extract-email-textarea');
  const text = textarea ? textarea.value : document.getElementById('email-content').textContent;
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

  syncExtractedFromInputs();

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
  } else {
    const data = await res.json();
    if (res.status === 403 && data.error === 'meeting_limit') {
      showLimitMessage(data.message);
    } else {
      alert(data.error || 'Failed to save meeting');
    }
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
    list.innerHTML = '<div class="empty-state">' +
      '<strong>No meetings yet</strong><br>' +
      'Upload a recording or paste your notes to get started.<br>' +
      'MeetingMind extracts action items and analyzes patterns across meetings — recurring topics, unresolved tasks, and follow-up signals build automatically.' +
      '</div>';
    return;
  }

  list.innerHTML = meetings.map(m => {
    const date = new Date(m.created_at + 'Z').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    const title = m.title || 'Untitled Meeting';
    const preview = m.raw_notes.length > 120
      ? m.raw_notes.substring(0, 120) + '...'
      : m.raw_notes;

    const hasActions = m.action_items.action_items && m.action_items.action_items.length > 0;
    const followUp = (m.action_items && m.action_items.follow_up_email) || '';
    let actionsHtml = '';
    if (hasActions || followUp) {
      const itemsRows = (m.action_items.action_items || []).map(item =>
        `<tr><td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td></tr>`
      ).join('');
      const emailSubject = encodeURIComponent(`Meeting follow-up \u2014 ${title}`);
      const emailBody = encodeURIComponent(followUp);
      const emailBtns = followUp ? `
          <div class="export-actions" style="margin-top:8px">
            <a class="btn btn-secondary btn-small" href="https://mail.google.com/mail/?view=cm&su=${emailSubject}&body=${emailBody}" target="_blank">Email (Gmail)</a>
            <a class="btn btn-secondary btn-small" href="https://outlook.live.com/mail/0/deeplink/compose?subject=${emailSubject}&body=${emailBody}" target="_blank">Email (Outlook)</a>
          </div>` : '';
      actionsHtml = `
        <details>
          <summary>View action items & email</summary>
          <div class="past-meeting-extraction" data-meeting-id="${m.id}">
            <div class="extraction-view-mode">
              <table class="action-items-table" style="margin-top:12px">
                <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th></tr></thead>
                <tbody>${itemsRows}</tbody>
              </table>
              <h4 style="margin:12px 0 8px">Follow-up Email</h4>
              <div class="email-box">${escapeHtml(followUp)}</div>${emailBtns}
              <div style="margin-top:12px">
                <button class="btn btn-secondary btn-small edit-extraction-btn" data-meeting-id="${m.id}">Edit</button>
              </div>
            </div>
            <div class="extraction-edit-mode" style="display:none"></div>
          </div>
        </details>
      `;
    }

    return `
      <div class="meeting-card">
        <div class="meeting-card-header">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <span class="date" style="margin-left:12px">${date}</span>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-secondary btn-small" onclick="viewMeeting(${m.id})">View</button>
            <button class="btn btn-danger btn-small" onclick="deleteMeeting(${m.id})">Delete</button>
          </div>
        </div>
        <div class="notes-preview">${escapeHtml(preview)}</div>
        ${actionsHtml}
      </div>
    `;
  }).join('');
}

// ---- View Meeting Detail ----
async function viewMeeting(id, highlight) {
  const res = await fetch(`/api/meetings/${id}`);
  if (!res.ok) {
    alert('Meeting not found');
    return;
  }

  const meeting = await res.json();
  currentMeetingId = meeting.id;
  originalTranscript = meeting.raw_notes;

  const date = new Date(meeting.created_at + 'Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const title = meeting.title || 'Untitled Meeting';
  document.getElementById('detail-title').textContent = title;
  document.getElementById('detail-date').textContent = date;

  // Transcript: show read-only, hide edit textarea
  const transcriptEl = document.getElementById('detail-transcript');
  transcriptEl.textContent = meeting.raw_notes;
  transcriptEl.style.display = 'block';
  document.getElementById('detail-transcript-edit').style.display = 'none';
  document.getElementById('edit-transcript-btn').style.display = 'inline-block';
  document.getElementById('edit-transcript-actions').style.display = 'none';
  document.getElementById('transcript-edit-status').textContent = '';

  // Set up export links
  const subject = encodeURIComponent(`Meeting Notes: ${title}`);
  const body = encodeURIComponent(`${title}\n${date}\n\n${meeting.raw_notes}`);
  document.getElementById('email-gmail-btn').href =
    `https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`;
  document.getElementById('email-outlook-btn').href =
    `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;

  // Render action items + follow-up email in detail view
  renderDetailExtraction(meeting.action_items);

  // Render summary
  var summarySection = document.getElementById('detail-summary-section');
  var summaryEl = document.getElementById('detail-summary');
  var summaryText = (meeting.action_items && meeting.action_items.summary) || '';
  if (summaryText) {
    summaryEl.textContent = summaryText;
    summarySection.style.display = 'block';
  } else {
    summarySection.style.display = 'none';
  }

  // Render open questions
  var questionsSection = document.getElementById('detail-questions-section');
  var questionsList = document.getElementById('detail-questions');
  var questions = (meeting.action_items && meeting.action_items.open_questions) || [];
  if (questions.length > 0) {
    questionsList.innerHTML = questions.map(function(q) { return '<li>' + escapeHtml(q) + '</li>'; }).join('');
    questionsSection.style.display = 'block';
  } else {
    questionsSection.style.display = 'none';
  }

  // Render proposed solutions
  renderDetailSolutions(meeting.action_items);

  // Load tracked issues for this meeting
  loadTrackedIssues(meeting.id);

  // Load "What Changed Since Last Meeting"
  loadWhatChanged(meeting.id);

  // Load cross-meeting insights
  loadInsights(meeting.id);

  // Show detail, hide list
  const detailEl = document.getElementById('meeting-detail');
  detailEl.style.display = 'block';
  document.getElementById('past-meetings-section').style.display = 'none';

  // Scroll to transcript and briefly highlight it after upload
  if (highlight) {
    detailEl.scrollIntoView({ behavior: 'smooth' });
    transcriptEl.classList.add('highlight');
    setTimeout(() => transcriptEl.classList.remove('highlight'), 2000);
  }
}

// Render action items in the meeting detail view
function renderDetailExtraction(actionData) {
  const section = document.getElementById('detail-extraction');
  const content = document.getElementById('detail-extraction-content');
  const items = (actionData && actionData.action_items) || [];
  const followUp = (actionData && actionData.follow_up_email) || '';

  if (items.length === 0 && !followUp) {
    section.style.display = 'none';
    return;
  }

  const itemsRows = items.map(item =>
    `<tr><td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td></tr>`
  ).join('');

  const emailSubject = encodeURIComponent('Meeting follow-up');
  const emailBody = encodeURIComponent(followUp);
  const emailBtns = followUp ? `
    <div class="export-actions" style="margin-top:8px">
      <a class="btn btn-secondary btn-small" href="https://mail.google.com/mail/?view=cm&su=${emailSubject}&body=${emailBody}" target="_blank">Email (Gmail)</a>
      <a class="btn btn-secondary btn-small" href="https://outlook.live.com/mail/0/deeplink/compose?subject=${emailSubject}&body=${emailBody}" target="_blank">Email (Outlook)</a>
    </div>` : '';

  content.innerHTML = `
    <div class="detail-extraction-wrapper" data-meeting-id="${currentMeetingId}">
      <div class="extraction-view-mode">
        <table class="action-items-table" style="margin-top:12px">
          <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th></tr></thead>
          <tbody>${itemsRows}</tbody>
        </table>
        <h4 style="margin:12px 0 8px">Follow-up Email</h4>
        <div class="email-box">${escapeHtml(followUp)}</div>${emailBtns}
        <div style="margin-top:12px">
          <button class="btn btn-secondary btn-small edit-extraction-btn" data-meeting-id="${currentMeetingId}">Edit</button>
        </div>
      </div>
      <div class="extraction-edit-mode" style="display:none"></div>
    </div>
  `;
  section.style.display = 'block';
}

document.getElementById('back-to-list').addEventListener('click', () => {
  document.getElementById('meeting-detail').style.display = 'none';
  document.getElementById('past-meetings-section').style.display = 'block';
});

// ---- Transcript Editing ----
document.getElementById('edit-transcript-btn').addEventListener('click', () => {
  const transcriptEl = document.getElementById('detail-transcript');
  const editEl = document.getElementById('detail-transcript-edit');
  originalTranscript = transcriptEl.textContent;
  editEl.value = originalTranscript;
  transcriptEl.style.display = 'none';
  editEl.style.display = 'block';
  editEl.focus();
  document.getElementById('edit-transcript-btn').style.display = 'none';
  document.getElementById('edit-transcript-actions').style.display = 'flex';
});

document.getElementById('cancel-transcript-btn').addEventListener('click', () => {
  document.getElementById('detail-transcript').style.display = 'block';
  document.getElementById('detail-transcript-edit').style.display = 'none';
  document.getElementById('edit-transcript-btn').style.display = 'inline-block';
  document.getElementById('edit-transcript-actions').style.display = 'none';
  document.getElementById('transcript-edit-status').textContent = '';
});

document.getElementById('save-transcript-btn').addEventListener('click', async () => {
  const editEl = document.getElementById('detail-transcript-edit');
  const statusEl = document.getElementById('transcript-edit-status');
  const saveBtn = document.getElementById('save-transcript-btn');
  const newText = editEl.value;

  if (newText.length > 200000) {
    statusEl.textContent = 'Too long (max 200,000 characters)';
    statusEl.className = 'edit-status error';
    return;
  }

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving\u2026';
  statusEl.className = 'edit-status saving';

  try {
    const res = await fetch(`/api/meetings/${currentMeetingId}/transcript`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: newText })
    });

    if (!res.ok) {
      const data = await res.json();
      statusEl.textContent = data.error || 'Save failed';
      statusEl.className = 'edit-status error';
      return;
    }

    // Exit edit mode
    originalTranscript = newText;
    const transcriptEl = document.getElementById('detail-transcript');
    transcriptEl.textContent = newText;
    transcriptEl.style.display = 'block';
    editEl.style.display = 'none';
    document.getElementById('edit-transcript-btn').style.display = 'inline-block';
    document.getElementById('edit-transcript-actions').style.display = 'none';

    // Update email export links
    const title = document.getElementById('detail-title').textContent;
    const date = document.getElementById('detail-date').textContent;
    const subject = encodeURIComponent(`Meeting Notes: ${title}`);
    const body = encodeURIComponent(`${title}\n${date}\n\n${newText}`);
    document.getElementById('email-gmail-btn').href =
      `https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`;
    document.getElementById('email-outlook-btn').href =
      `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;

    statusEl.textContent = 'Saved!';
    statusEl.className = 'edit-status saved';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);

    loadMeetings();
  } catch (err) {
    statusEl.textContent = 'Something went wrong';
    statusEl.className = 'edit-status error';
  } finally {
    saveBtn.disabled = false;
  }
});

// ---- Copy Transcript ----
document.getElementById('copy-transcript-btn').addEventListener('click', () => {
  const text = document.getElementById('detail-transcript').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-transcript-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy transcript'; }, 2000);
  });
});

// ---- Use Transcript for Extraction ----
document.getElementById('use-for-extract-btn').addEventListener('click', () => {
  const transcript = document.getElementById('detail-transcript').textContent;
  if (!transcript) return;

  // Fill the notes textarea with the transcript
  notesInput.value = transcript;

  // Navigate back to the extraction area
  document.getElementById('meeting-detail').style.display = 'none';
  document.getElementById('past-meetings-section').style.display = 'block';

  // Scroll to the extract section and focus
  notesInput.scrollIntoView({ behavior: 'smooth' });
  notesInput.focus();
});

// ---- Extraction Editing (past meetings + detail view) ----
document.addEventListener('click', (e) => {
  const target = e.target;

  // Edit button
  if (target.classList.contains('edit-extraction-btn')) {
    const container = target.closest('.past-meeting-extraction') || target.closest('.detail-extraction-wrapper');
    if (container) enterExtractionEditMode(container, target.dataset.meetingId);
    return;
  }

  // Save button
  if (target.classList.contains('save-extraction-btn')) {
    const container = target.closest('.past-meeting-extraction') || target.closest('.detail-extraction-wrapper');
    if (container) saveExtractionEdit(container, target.dataset.meetingId);
    return;
  }

  // Cancel button
  if (target.classList.contains('cancel-extraction-btn')) {
    const container = target.closest('.past-meeting-extraction') || target.closest('.detail-extraction-wrapper');
    if (container) cancelExtractionEdit(container);
    return;
  }

  // Delete row in past meeting / detail edit
  if (target.classList.contains('pm-delete-row-btn')) {
    target.closest('tr').remove();
    return;
  }

  // Add item in past meeting / detail edit
  if (target.classList.contains('pm-add-item-btn')) {
    const tbody = target.closest('.extraction-edit-mode').querySelector('tbody');
    tbody.appendChild(createEditableRow({ task: '', owner: '', deadline: '' }, 'pm'));
    return;
  }
});

function enterExtractionEditMode(container, meetingId) {
  const viewMode = container.querySelector('.extraction-view-mode');
  const editMode = container.querySelector('.extraction-edit-mode');

  // Parse current data from view mode table
  const rows = viewMode.querySelectorAll('tbody tr');
  const items = [];
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    items.push({
      task: cells[0] ? cells[0].textContent : '',
      owner: cells[1] ? cells[1].textContent : '',
      deadline: cells[2] ? cells[2].textContent : ''
    });
  });

  const emailBox = viewMode.querySelector('.email-box');
  const emailText = emailBox ? emailBox.textContent : '';

  editMode.innerHTML = `
    <table class="action-items-table editable" style="margin-top:12px">
      <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th><th style="width:40px"></th></tr></thead>
      <tbody></tbody>
    </table>
    <button class="btn btn-secondary btn-small add-item-btn pm-add-item-btn">+ Add item</button>
    <h4 style="margin:12px 0 8px">Follow-up Email</h4>
    <div class="editable-email">
      <textarea class="pm-email-textarea"></textarea>
    </div>
    <div class="extraction-edit-actions">
      <button class="btn btn-primary btn-small save-extraction-btn" data-meeting-id="${meetingId}">Save</button>
      <button class="btn btn-secondary btn-small cancel-extraction-btn">Cancel</button>
      <span class="edit-status pm-edit-status"></span>
    </div>
  `;

  // Populate rows safely (avoid attribute injection)
  const tbody = editMode.querySelector('tbody');
  items.forEach(item => tbody.appendChild(createEditableRow(item, 'pm')));
  editMode.querySelector('.pm-email-textarea').value = emailText;

  viewMode.style.display = 'none';
  editMode.style.display = 'block';
}

function cancelExtractionEdit(container) {
  container.querySelector('.extraction-view-mode').style.display = 'block';
  container.querySelector('.extraction-edit-mode').style.display = 'none';
}

async function saveExtractionEdit(container, meetingId) {
  const editMode = container.querySelector('.extraction-edit-mode');
  const statusEl = editMode.querySelector('.pm-edit-status');
  const saveBtn = editMode.querySelector('.save-extraction-btn');

  const rows = editMode.querySelectorAll('tbody tr');
  const items = [];
  rows.forEach(tr => {
    const task = tr.querySelector('.pm-task');
    if (task && task.value.trim()) {
      items.push({
        task: task.value.trim(),
        owner: (tr.querySelector('.pm-owner') || {}).value || '',
        deadline: (tr.querySelector('.pm-deadline') || {}).value || ''
      });
    }
  });

  const emailTa = editMode.querySelector('.pm-email-textarea');
  const followUp = emailTa ? emailTa.value : '';

  saveBtn.disabled = true;
  statusEl.textContent = 'Saving\u2026';
  statusEl.className = 'edit-status pm-edit-status saving';

  try {
    const res = await fetch(`/api/meetings/${meetingId}/extraction`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_items: items, follow_up_email: followUp })
    });

    if (!res.ok) {
      const data = await res.json();
      statusEl.textContent = data.error || 'Save failed';
      statusEl.className = 'edit-status pm-edit-status error';
      return;
    }

    // Refresh meetings list and re-render detail view if viewing this meeting
    await loadMeetings();
    if (currentMeetingId === Number(meetingId)) {
      viewMeeting(currentMeetingId);
    }
  } catch (err) {
    statusEl.textContent = 'Something went wrong';
    statusEl.className = 'edit-status pm-edit-status error';
  } finally {
    saveBtn.disabled = false;
  }
}

// ---- Delete Meeting ----
async function deleteMeeting(id) {
  if (!confirm('Delete this meeting?')) return;

  const res = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
  if (res.ok) loadMeetings();
}

// (Recording removed — use Live Meeting instead)

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
  banner.innerHTML = escapeHtml(message) +
    ' <a href="/pricing.html" class="upgrade-link">Upgrade now</a>';
  banner.style.display = 'block';
}

// ---- Zoom Integration ----
(function initZoom() {
  var zoomSection = document.getElementById('zoom-section');
  var zoomNotConnected = document.getElementById('zoom-not-connected');
  var zoomConnected = document.getElementById('zoom-connected');
  var zoomBadge = document.getElementById('zoom-status-badge');
  var zoomList = document.getElementById('zoom-recordings-list');

  if (!zoomSection) return;

  // Check URL params for Zoom callback status
  var params = new URLSearchParams(window.location.search);
  if (params.get('zoom') === 'connected') {
    history.replaceState(null, '', '/dashboard.html');
  }

  function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function checkZoomStatus() {
    try {
      var res = await fetch('/api/zoom/status');
      var data = await res.json();
      if (!data.configured) {
        zoomSection.style.display = 'none';
        return;
      }
      zoomSection.style.display = 'block';
      if (data.connected) {
        zoomNotConnected.style.display = 'none';
        zoomConnected.style.display = 'block';
        zoomBadge.innerHTML = '<span class="status-badge status-badge--connected">Connected</span>';
        loadZoomRecordings();
      } else {
        zoomNotConnected.style.display = 'block';
        zoomConnected.style.display = 'none';
        zoomBadge.innerHTML = '<span class="status-badge status-badge--disconnected">Not connected</span>';
      }
    } catch (e) {
      zoomSection.style.display = 'none';
    }
  }

  async function loadZoomRecordings() {
    zoomList.innerHTML = '<p style="color:#888;font-size:0.9rem">Loading recordings...</p>';
    try {
      var res = await fetch('/api/zoom/recordings');
      if (res.status === 401) {
        zoomList.innerHTML = '<p style="color:#e63946;font-size:0.9rem">Zoom session expired. Please reconnect.</p>';
        return;
      }
      if (!res.ok) {
        zoomList.innerHTML = '<p style="color:#e63946;font-size:0.9rem">Could not load Zoom recordings.</p>';
        return;
      }
      var meetings = await res.json();
      if (meetings.length === 0) {
        zoomList.innerHTML = '<p style="color:#888;font-size:0.9rem">No cloud recordings found in the last 30 days. Make sure cloud recording is enabled in your Zoom settings.</p>';
        return;
      }
      zoomList.innerHTML = meetings.map(function(m) {
        var date = m.start_time ? new Date(m.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        var dur = m.duration ? m.duration + ' min' : '';
        // Prefer audio_only (M4A), fall back to first available recording
        var audioRec = m.recordings.find(function(r) { return r.recording_type === 'audio_only'; });
        var bestRec = audioRec || m.recordings[0];
        var fileInfo = bestRec.file_type + (bestRec.file_size ? ' · ' + formatFileSize(bestRec.file_size) : '');

        return '<div class="zoom-recording-row" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f0f0f0;gap:10px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:0">' +
            '<strong style="word-break:break-word">' + escapeHtml(m.topic) + '</strong><br>' +
            '<span style="font-size:0.8rem;color:#888">' + date + (dur ? ' · ' + dur : '') + ' · ' + fileInfo + '</span>' +
          '</div>' +
          '<button class="btn btn-primary btn-small zoom-import-btn" ' +
            'data-meeting-id="' + escapeHtml(m.meeting_id) + '" ' +
            'data-recording-id="' + escapeHtml(bestRec.id) + '" ' +
            'data-topic="' + escapeHtml(m.topic) + '" ' +
            'data-start="' + escapeHtml(m.start_time || '') + '" ' +
            'style="white-space:nowrap">Import &amp; Transcribe</button>' +
        '</div>';
      }).join('');
    } catch (e) {
      zoomList.innerHTML = '<p style="color:#e63946;font-size:0.9rem">Failed to load recordings.</p>';
    }
  }

  // Event delegation for import buttons
  zoomList.addEventListener('click', async function(e) {
    var btn = e.target.closest('.zoom-import-btn');
    if (!btn) return;

    var meetingId = btn.getAttribute('data-meeting-id');
    var recordingId = btn.getAttribute('data-recording-id');
    var topic = btn.getAttribute('data-topic');
    var startTime = btn.getAttribute('data-start');

    btn.disabled = true;
    btn.textContent = 'Importing…';

    try {
      var res = await fetch('/api/zoom/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meeting_id: meetingId, recording_id: recordingId, topic: topic, start_time: startTime })
      });

      var data = await res.json();

      if (!res.ok) {
        btn.disabled = false;
        btn.textContent = 'Import & Transcribe';
        if (data.error === 'meeting_limit') {
          alert(data.message || 'Meeting storage limit reached. Upgrade for unlimited storage.');
        } else {
          alert(data.error || 'Import failed. Please try again.');
        }
        return;
      }

      btn.textContent = 'Imported!';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');

      // Refresh meetings list to show the new import
      if (typeof loadMeetings === 'function') loadMeetings();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Import & Transcribe';
      alert('Failed to import recording. Please try again.');
    }
  });

  document.getElementById('zoom-disconnect-btn').addEventListener('click', async function() {
    if (!confirm('Disconnect Zoom account?')) return;
    await fetch('/api/zoom/disconnect', { method: 'POST' });
    checkZoomStatus();
  });

  document.getElementById('zoom-refresh-btn').addEventListener('click', function() {
    loadZoomRecordings();
  });

  checkZoomStatus();
})();

// ---- Solutions Section ----
function renderDetailSolutions(actionData) {
  var section = document.getElementById('detail-solutions-section');
  var list = document.getElementById('detail-solutions');
  var solutions = (actionData && actionData.proposed_solutions) || [];
  if (solutions.length > 0) {
    list.innerHTML = solutions.map(function(s, i) {
      return '<li>' + escapeHtml(s) + '</li>';
    }).join('');
    section.style.display = 'block';
  } else {
    list.innerHTML = '';
    section.style.display = 'block'; // Always show so users can add
  }
}

document.getElementById('add-solution-btn').addEventListener('click', function() {
  var text = prompt('Enter a proposed or agreed solution:');
  if (!text || !text.trim()) return;

  // Add to the existing extraction data
  if (!currentMeetingId) return;
  fetch('/api/meetings/' + currentMeetingId).then(function(r) { return r.json(); }).then(function(meeting) {
    var data = meeting.action_items || {};
    if (!data.proposed_solutions) data.proposed_solutions = [];
    data.proposed_solutions.push(text.trim());

    return fetch('/api/meetings/' + currentMeetingId + '/extraction', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_items: data.action_items || [],
        follow_up_email: data.follow_up_email || '',
        open_questions: data.open_questions || [],
        proposed_solutions: data.proposed_solutions,
        summary: data.summary || ''
      })
    });
  }).then(function() {
    viewMeeting(currentMeetingId);
  });
});

// ---- Tracked Issues (Unresolved / Resolved) ----
function loadTrackedIssues(meetingId) {
  fetch('/api/meetings/issues').then(function(r) { return r.json(); }).then(function(issues) {
    var unresolved = issues.filter(function(i) { return !i.resolved; });
    var resolved = issues.filter(function(i) { return i.resolved; });

    var issuesSection = document.getElementById('detail-issues-section');
    var issuesList = document.getElementById('detail-issues-list');
    var issuesEmpty = document.getElementById('detail-issues-empty');

    if (unresolved.length > 0) {
      issuesList.innerHTML = unresolved.map(renderIssueCard).join('');
      issuesEmpty.style.display = 'none';
    } else {
      issuesList.innerHTML = '';
      issuesEmpty.style.display = 'block';
    }
    issuesSection.style.display = 'block';

    var resolvedSection = document.getElementById('detail-resolved-section');
    var resolvedList = document.getElementById('detail-resolved-list');
    if (resolved.length > 0) {
      resolvedList.innerHTML = resolved.map(renderIssueCard).join('');
      resolvedSection.style.display = 'block';
    } else {
      resolvedSection.style.display = 'none';
    }
  }).catch(function() {
    document.getElementById('detail-issues-section').style.display = 'none';
    document.getElementById('detail-resolved-section').style.display = 'none';
  });
}

function renderIssueCard(issue) {
  var checked = issue.resolved ? 'checked' : '';
  var resolvedClass = issue.resolved ? ' issue-resolved' : '';
  var source = issue.source_meeting_title ? ' <span class="issue-source">from ' + escapeHtml(issue.source_meeting_title) + '</span>' : '';
  var notesHtml = issue.notes ? '<div class="issue-notes">' + escapeHtml(issue.notes) + '</div>' : '';
  var dateStr = '';
  if (issue.resolved_at) {
    try { dateStr = ' <span class="issue-date">Resolved ' + new Date(issue.resolved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</span>'; } catch(e) {}
  } else if (issue.created_at) {
    try { dateStr = ' <span class="issue-date">' + new Date(issue.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</span>'; } catch(e) {}
  }

  return '<div class="issue-card' + resolvedClass + '">' +
    '<label class="issue-checkbox-label">' +
    '<input type="checkbox" class="issue-checkbox" data-issue-id="' + issue.id + '" ' + checked + '>' +
    '<span class="issue-text">' + escapeHtml(issue.issue_text) + '</span>' +
    source + dateStr +
    '</label>' +
    notesHtml +
    '</div>';
}

// Event delegation for issue checkboxes
document.addEventListener('change', function(e) {
  if (!e.target.classList.contains('issue-checkbox')) return;
  var issueId = e.target.getAttribute('data-issue-id');
  var resolved = e.target.checked;

  fetch('/api/meetings/issues/' + issueId, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved: resolved })
  }).then(function() {
    if (currentMeetingId) loadTrackedIssues(currentMeetingId);
  });
});

// Auto-create tracked issues from cross-meeting insights
function autoTrackUnresolvedItems(insights) {
  var unresolvedInsight = insights.find(function(i) { return i.type === 'unresolved_items'; });
  if (!unresolvedInsight || !unresolvedInsight.details) return;

  // Get existing issues to avoid duplicates
  fetch('/api/meetings/issues').then(function(r) { return r.json(); }).then(function(existing) {
    var existingTexts = existing.map(function(i) { return i.issue_text.toLowerCase().trim(); });

    unresolvedInsight.details.forEach(function(item) {
      var text = item.task;
      if (!text || existingTexts.includes(text.toLowerCase().trim())) return;

      fetch('/api/meetings/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issue_text: text,
          source_meeting_title: item.from_meeting || ''
        })
      });
    });
  });
}

// ---- What Changed Since Last Meeting ----
function loadWhatChanged(meetingId) {
  var section = document.getElementById('detail-whatchanged-section');
  var content = document.getElementById('detail-whatchanged-content');

  fetch('/api/meetings/' + meetingId + '/whatchanged').then(function(r) { return r.json(); }).then(function(data) {
    if (!data.has_prior) {
      section.style.display = 'none';
      return;
    }

    var html = '<p style="font-size:0.85rem;color:var(--color-text-muted);margin-bottom:12px">Compared to: <strong>' + escapeHtml(data.prior_meeting.title) + '</strong></p>';

    if (data.new_action_items && data.new_action_items.length > 0) {
      html += '<div class="whatchanged-group"><h4>New Action Items</h4><ul>' +
        data.new_action_items.map(function(t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul></div>';
    }

    if (data.resolved_since_last && data.resolved_since_last.length > 0) {
      html += '<div class="whatchanged-group"><h4>Resolved Since Last Meeting</h4><ul>' +
        data.resolved_since_last.map(function(t) { return '<li class="resolved-item">' + escapeHtml(t) + '</li>'; }).join('') + '</ul></div>';
    }

    if (data.new_solutions && data.new_solutions.length > 0) {
      html += '<div class="whatchanged-group"><h4>New Solutions</h4><ul>' +
        data.new_solutions.map(function(s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') + '</ul></div>';
    }

    if (data.new_questions && data.new_questions.length > 0) {
      html += '<div class="whatchanged-group"><h4>New Questions</h4><ul>' +
        data.new_questions.map(function(q) { return '<li>' + escapeHtml(q) + '</li>'; }).join('') + '</ul></div>';
    }

    if (data.new_topics && data.new_topics.length > 0) {
      html += '<div class="whatchanged-group"><h4>New Topics</h4><div>' +
        data.new_topics.map(function(t) { return '<span class="insight-tag">' + escapeHtml(t) + '</span>'; }).join('') + '</div></div>';
    }

    if (data.dropped_topics && data.dropped_topics.length > 0) {
      html += '<div class="whatchanged-group"><h4>Topics No Longer Discussed</h4><div>' +
        data.dropped_topics.map(function(t) { return '<span class="insight-tag" style="opacity:0.6">' + escapeHtml(t) + '</span>'; }).join('') + '</div></div>';
    }

    content.innerHTML = html;
    section.style.display = 'block';
  }).catch(function() {
    section.style.display = 'none';
  });
}

// ---- Cross-Meeting Intelligence ----
const INSIGHT_ICONS = {
  repeated_topics: '\u{1F504}',
  unresolved_items: '\u{26A0}',
  follow_up_signals: '\u{1F517}',
  recurring_participants: '\u{1F465}',
  new_topics: '\u{2728}',
  recurring_solutions: '\u{1F4A1}'
};

async function loadInsights(meetingId) {
  const section = document.getElementById('insights-section');
  const content = document.getElementById('insights-content');
  const emptyEl = document.getElementById('insights-empty');

  section.style.display = 'block';
  content.innerHTML = '<p class="insights-loading">Analyzing meeting connections...</p>';
  emptyEl.style.display = 'none';

  try {
    const res = await fetch(`/api/meetings/${meetingId}/insights`);
    if (!res.ok) {
      section.style.display = 'none';
      return;
    }

    const data = await res.json();

    if (!data.insights || data.insights.length === 0) {
      content.innerHTML = '';
      emptyEl.textContent = data.message || 'No cross-meeting patterns detected yet. Insights will appear as you add more meetings.';
      emptyEl.style.display = 'block';
      return;
    }

    emptyEl.style.display = 'none';
    content.innerHTML = data.insights.map(renderInsightCard).join('');

    // Auto-track unresolved items as issues
    autoTrackUnresolvedItems(data.insights);
    // Refresh issues list after auto-tracking
    setTimeout(function() { if (currentMeetingId) loadTrackedIssues(currentMeetingId); }, 500);
  } catch (err) {
    section.style.display = 'none';
  }
}

function renderInsightCard(insight) {
  const icon = INSIGHT_ICONS[insight.type] || '\u{1F4A1}';
  let detailsHtml = '';

  if (insight.type === 'repeated_topics' && Array.isArray(insight.details)) {
    detailsHtml = '<ul class="insight-detail-list">' +
      insight.details.map(d =>
        `<li><strong>${escapeHtml(d.meeting)}</strong> &mdash; ${escapeHtml(formatInsightDate(d.date))}` +
        (d.topics ? ': ' + d.topics.map(t => `<span class="insight-tag">${escapeHtml(t)}</span>`).join('') : '') +
        '</li>'
      ).join('') + '</ul>';
  } else if (insight.type === 'unresolved_items' && Array.isArray(insight.details)) {
    detailsHtml = '<ul class="insight-detail-list">' +
      insight.details.map(d =>
        `<li>"${escapeHtml(d.task)}"` +
        (d.owner ? ` (${escapeHtml(d.owner)})` : '') +
        ` &mdash; from <strong>${escapeHtml(d.from_meeting)}</strong></li>`
      ).join('') + '</ul>';
  } else if (insight.type === 'recurring_participants' && Array.isArray(insight.details)) {
    detailsHtml = '<div style="margin-top:4px">' +
      insight.details.map(d =>
        `<span class="insight-tag">${escapeHtml(d.name)} (${d.meeting_count} meetings)</span>`
      ).join('') + '</div>';
  } else if (insight.type === 'new_topics' && Array.isArray(insight.details)) {
    detailsHtml = '<div style="margin-top:4px">' +
      insight.details.map(t =>
        `<span class="insight-tag">${escapeHtml(t)}</span>`
      ).join('') + '</div>';
  } else if (insight.type === 'follow_up_signals' && Array.isArray(insight.details)) {
    detailsHtml = '<div style="margin-top:4px">' +
      insight.details.map(s =>
        `<span class="insight-tag">"${escapeHtml(s)}"</span>`
      ).join('') + '</div>';
  } else if (insight.type === 'recurring_solutions' && Array.isArray(insight.details)) {
    detailsHtml = '<ul class="insight-detail-list">' +
      insight.details.map(d =>
        `<li>"${escapeHtml(d.solution)}"` +
        ` &mdash; similar to "${escapeHtml(d.prior_solution)}"` +
        ` from <strong>${escapeHtml(d.from_meeting)}</strong></li>`
      ).join('') + '</ul>';
  }

  return `<div class="insight-card">
    <div class="insight-card-header">
      <span class="insight-icon ${escapeHtml(insight.type)}">${icon}</span>
      <span class="insight-card-title">${escapeHtml(insight.title)}</span>
    </div>
    <div class="insight-card-description">${escapeHtml(insight.description)}</div>
    ${detailsHtml}
  </div>`;
}

function formatInsightDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return dateStr; }
}

// ---- Utility ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
