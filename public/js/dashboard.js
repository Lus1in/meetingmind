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

checkAuth().then(loadMeetings);

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

  // Set up email buttons for extracted follow-up
  const emailActions = document.getElementById('extract-email-actions');
  if (data.follow_up_email) {
    const subject = encodeURIComponent('Meeting follow-up');
    const body = encodeURIComponent(data.follow_up_email);
    document.getElementById('extract-gmail-btn').href =
      `https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`;
    document.getElementById('extract-outlook-btn').href =
      `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;
    emailActions.style.display = 'flex';
  } else {
    emailActions.style.display = 'none';
  }

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
      'Upload a recording from your last call, standup, or interview.<br>' +
      'MeetingMind will transcribe it and save it here for you.' +
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
    let actionsHtml = '';
    if (hasActions) {
      const itemsRows = m.action_items.action_items.map(item =>
        `<tr><td>${escapeHtml(item.task)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.deadline)}</td></tr>`
      ).join('');
      const followUp = m.action_items.follow_up_email || '';
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
          <table class="action-items-table" style="margin-top:12px">
            <thead><tr><th>Task</th><th>Owner</th><th>Deadline</th></tr></thead>
            <tbody>${itemsRows}</tbody>
          </table>
          <h4 style="margin:12px 0 8px">Follow-up Email</h4>
          <div class="email-box">${escapeHtml(followUp)}</div>${emailBtns}
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
  const date = new Date(meeting.created_at + 'Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });

  const title = meeting.title || 'Untitled Meeting';
  document.getElementById('detail-title').textContent = title;
  document.getElementById('detail-date').textContent = date;
  document.getElementById('detail-transcript').textContent = meeting.raw_notes;

  // Set up export links
  const subject = encodeURIComponent(`Meeting Notes: ${title}`);
  const body = encodeURIComponent(`${title}\n${date}\n\n${meeting.raw_notes}`);
  document.getElementById('email-gmail-btn').href =
    `https://mail.google.com/mail/?view=cm&su=${subject}&body=${body}`;
  document.getElementById('email-outlook-btn').href =
    `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;

  // Show detail, hide list
  const detailEl = document.getElementById('meeting-detail');
  detailEl.style.display = 'block';
  document.getElementById('past-meetings-section').style.display = 'none';

  // Scroll to transcript and briefly highlight it after upload
  if (highlight) {
    detailEl.scrollIntoView({ behavior: 'smooth' });
    const transcriptEl = document.getElementById('detail-transcript');
    transcriptEl.classList.add('highlight');
    setTimeout(() => transcriptEl.classList.remove('highlight'), 2000);
  }
}

document.getElementById('back-to-list').addEventListener('click', () => {
  document.getElementById('meeting-detail').style.display = 'none';
  document.getElementById('past-meetings-section').style.display = 'block';
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

// ---- Delete Meeting ----
async function deleteMeeting(id) {
  if (!confirm('Delete this meeting?')) return;

  const res = await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
  if (res.ok) loadMeetings();
}

// ---- Voice Recording ----
const recordBtn = document.getElementById('record-btn');
const stopBtn = document.getElementById('stop-btn');
const recordingPanel = document.getElementById('recording-panel');
const recTimer = document.getElementById('rec-timer');

const MAX_RECORDING_SECS = 600; // 10 minutes
let mediaRecorder = null;
let audioChunks = [];
let recordingStart = 0;
let timerInterval = null;

recordBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      handleRecordingComplete();
    };

    mediaRecorder.start();
    recordingStart = Date.now();

    // Show recording UI
    recordingPanel.style.display = 'flex';
    recordBtn.disabled = true;
    extractBtn.disabled = true;
    notesInput.disabled = true;

    // Start timer
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordingStart) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      recTimer.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

      // Auto-stop at max duration
      if (elapsed >= MAX_RECORDING_SECS) {
        mediaRecorder.stop();
      }
    }, 1000);
  } catch (err) {
    alert('Microphone access denied. Please allow microphone access to record.');
  }
});

stopBtn.addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
});

async function handleRecordingComplete() {
  clearInterval(timerInterval);
  recordingPanel.style.display = 'none';
  recTimer.textContent = '0:00';

  // Show processing state
  recordBtn.disabled = true;
  extractBtn.disabled = true;
  uploadBtn.disabled = true;
  recordBtn.innerHTML = '<span class="spinner spinner-dark"></span>Transcribing\u2026';

  try {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    if (blob.size < 1000) {
      uploadStatus.textContent = 'Recording too short. Please try again.';
      uploadStatus.className = 'upload-status error';
      return;
    }

    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');

    const res = await fetch('/api/meetings/upload', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      const errData = await res.json();
      if (res.status === 403 && errData.error === 'meeting_limit') {
        showLimitMessage(errData.message);
      } else {
        uploadStatus.textContent = errData.error || 'Transcription failed. Please try again.';
        uploadStatus.className = 'upload-status error';
      }
      return;
    }

    const data = await res.json();
    uploadStatus.textContent = 'Saved!';
    uploadStatus.className = 'upload-status saved';

    await loadMeetings();
    viewMeeting(data.id, true);

    setTimeout(() => {
      uploadStatus.textContent = '';
      uploadStatus.className = 'upload-status';
    }, 3000);
  } catch (err) {
    uploadStatus.textContent = 'Something went wrong. Please try again.';
    uploadStatus.className = 'upload-status error';
  } finally {
    recordBtn.disabled = false;
    recordBtn.textContent = 'Record Meeting';
    extractBtn.disabled = false;
    extractBtn.textContent = 'Extract Action Items';
    uploadBtn.disabled = false;
    notesInput.disabled = false;
  }
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
  banner.innerHTML = escapeHtml(message) +
    ' <a href="/pricing.html" class="upgrade-link">Upgrade now</a>';
  banner.style.display = 'block';
}

// ---- Utility ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
