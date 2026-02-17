// ---- Debug flag (set to true in console to enable) ----
var LIVE_DEBUG = false;
function dbg() { if (LIVE_DEBUG) console.log.apply(console, ['[live]'].concat(Array.prototype.slice.call(arguments))); }

// ---- Auth Guard ----
(async function checkAuth() {
  var res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = '/login.html';
    return;
  }
})();

// Logout
document.getElementById('logout-btn').addEventListener('click', async function() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
});

// ---- State ----
var sessionId = null;
var mediaRecorder = null;
var audioStream = null;
var eventSource = null;
var timerInterval = null;
var chunkInterval = null;
var memoryHintsInterval = null;
var recordingStart = 0;
var autoScroll = true;
var isPaused = false;
var isStopping = false;
var chunkCounter = 0;

// ---- DOM Refs ----
var setupPhase = document.getElementById('setup-phase');
var sessionPhase = document.getElementById('session-phase');
var processingPhase = document.getElementById('processing-phase');
var startBtn = document.getElementById('start-live-btn');
var consentCheck = document.getElementById('live-consent-check');
var titleInput = document.getElementById('live-title');
var participantsInput = document.getElementById('live-participants');
var setupError = document.getElementById('setup-error');
var liveTranscript = document.getElementById('live-transcript');
var transcriptEmpty = document.getElementById('transcript-empty');
var liveTimer = document.getElementById('live-timer');
var liveTitleDisplay = document.getElementById('live-title-display');
var liveIndicator = document.getElementById('live-indicator');
var liveStatusText = document.getElementById('live-status-text');
var scrollToggle = document.getElementById('scroll-toggle');
var pauseBtn = document.getElementById('pause-btn');
var stopBtn = document.getElementById('stop-live-btn');
var memoryHintsSection = document.getElementById('memory-hints-section');
var memoryHintsList = document.getElementById('memory-hints-list');

// ---- Consent enables start button ----
consentCheck.addEventListener('change', function() {
  startBtn.disabled = !consentCheck.checked;
});

// ---- Prevent accidental page leave during live session ----
window.addEventListener('beforeunload', function(e) {
  if (sessionId) {
    e.preventDefault();
    e.returnValue = 'You have a live meeting in progress. Are you sure you want to leave?';
  }
});

// ---- Auto-scroll toggle ----
scrollToggle.addEventListener('click', function() {
  autoScroll = !autoScroll;
  scrollToggle.textContent = 'Auto-scroll: ' + (autoScroll ? 'On' : 'Off');
});

// Pause auto-scroll on manual scroll up
liveTranscript.addEventListener('scroll', function() {
  var el = liveTranscript;
  var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  if (!atBottom && autoScroll) {
    autoScroll = false;
    scrollToggle.textContent = 'Auto-scroll: Off';
  }
});

// ---- Start Live Meeting ----
startBtn.addEventListener('click', async function() {
  var title = titleInput.value.trim();
  if (!title) {
    showSetupError('Please enter a meeting title.');
    titleInput.focus();
    return;
  }

  startBtn.disabled = true;
  startBtn.innerHTML = '<span class="spinner spinner-dark"></span>Starting...';
  hideSetupError();

  try {
    // Request mic permission first
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showSetupError('Microphone access denied. Please allow microphone access and try again.');
    startBtn.disabled = false;
    startBtn.textContent = 'Start Recording';
    return;
  }

  try {
    // Create server session
    var res = await fetch('/api/live/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title,
        participants: participantsInput.value.trim()
      })
    });

    if (!res.ok) {
      var errData = await res.json();
      if (errData.error === 'session_active') {
        sessionId = errData.session_id;
      } else {
        throw new Error(errData.message || errData.error || 'Failed to start session');
      }
    } else {
      var data = await res.json();
      sessionId = data.session_id;
    }

    dbg('Session started:', sessionId);
    startLiveSession(title);
  } catch (err) {
    showSetupError(err.message || 'Something went wrong. Please try again.');
    if (audioStream) {
      audioStream.getTracks().forEach(function(t) { t.stop(); });
      audioStream = null;
    }
    startBtn.disabled = false;
    startBtn.textContent = 'Start Recording';
  }
});

function startLiveSession(title) {
  setupPhase.style.display = 'none';
  sessionPhase.style.display = 'flex';

  liveTitleDisplay.textContent = title;
  recordingStart = Date.now();
  chunkCounter = 0;
  isStopping = false;

  // Start timer
  timerInterval = setInterval(updateTimer, 1000);

  // Connect SSE for receiving transcript segments
  connectSSE();

  // Start chunked recording cycle
  startChunkCycle();

  // Start memory hints polling (every 45s, 30s initial delay)
  memoryHintsInterval = setTimeout(function() {
    fetchMemoryHints();
    memoryHintsInterval = setInterval(fetchMemoryHints, 45000);
  }, 30000);
}

// ---- SSE Connection ----
function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource('/api/live/' + sessionId + '/stream');

  eventSource.onopen = function() {
    dbg('SSE connected');
    setStatus('live');
  };

  eventSource.onmessage = function(e) {
    dbg('SSE message:', e.data.substring(0, 80));
    try {
      var segment = JSON.parse(e.data);
      appendSegment(segment);
    } catch (err) {
      dbg('SSE parse error:', err.message);
    }
  };

  eventSource.addEventListener('connected', function() {
    setStatus('live');
  });

  eventSource.addEventListener('stopped', function() {
    dbg('SSE stopped event received');
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  });

  eventSource.onerror = function() {
    if (eventSource && eventSource.readyState === EventSource.CONNECTING) {
      dbg('SSE reconnecting...');
      setStatus('reconnecting');
    } else if (eventSource && eventSource.readyState === EventSource.CLOSED) {
      dbg('SSE closed');
      setStatus('disconnected');
    }
  };
}

// ================================================================
// Chunked Recording
//
// KEY FIX: We do NOT use MediaRecorder's timeslice parameter.
// WebM chunks from timeslice are NOT standalone audio files — only
// the first chunk has the container header. Whisper rejects headerless
// continuation chunks.
//
// Instead, we run a cycle: start recorder → wait 5s → stop recorder
// (which produces a complete standalone file) → send it → start again.
// ================================================================

function startChunkCycle() {
  captureOneChunk();
}

function captureOneChunk() {
  if (isStopping || !audioStream) return;
  if (isPaused) {
    // Re-check after 1 second
    setTimeout(captureOneChunk, 1000);
    return;
  }

  var mimeType = getSupportedMimeType();
  var chunks = [];

  try {
    var opts = {};
    if (mimeType) opts.mimeType = mimeType;
    mediaRecorder = new MediaRecorder(audioStream, opts);
  } catch (err) {
    dbg('MediaRecorder init error:', err.message);
    // Fallback — try without mimeType
    mediaRecorder = new MediaRecorder(audioStream);
  }

  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) {
      chunks.push(e.data);
    }
  };

  mediaRecorder.onstop = function() {
    if (chunks.length === 0 || isStopping) return;

    var blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
    dbg('Chunk', chunkCounter, 'captured, size:', blob.size);
    chunkCounter++;
    sendChunk(blob);

    // Start next chunk cycle (if not stopping)
    if (!isStopping && !isPaused) {
      captureOneChunk();
    } else if (isPaused) {
      // Wait for resume
      setTimeout(captureOneChunk, 1000);
    }
  };

  mediaRecorder.start();
  dbg('Recording chunk, will stop in 5s');

  // Stop after 5 seconds to produce a complete standalone file
  setTimeout(function() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }, 5000);
}

function getSupportedMimeType() {
  var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (var i = 0; i < types.length; i++) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(types[i])) return types[i];
  }
  return '';
}

async function sendChunk(blob) {
  if (!sessionId) return;

  var timestampMs = Date.now() - recordingStart;
  var formData = new FormData();
  formData.append('audio', blob, 'chunk.webm');
  formData.append('timestamp_ms', timestampMs.toString());

  dbg('Sending chunk, size:', blob.size, 'timestamp:', timestampMs);

  try {
    var res = await fetch('/api/live/' + sessionId + '/chunk', {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      var errData = await res.json();
      if (res.status === 401) {
        window.location.href = '/login.html';
        return;
      }
      dbg('Chunk upload failed:', errData.error);
    } else {
      var resData = await res.json();
      dbg('Chunk upload OK, segment_index:', resData.segment_index, 'silent:', resData.silent);
    }
  } catch (err) {
    dbg('Chunk upload network error:', err.message);
    setStatus('reconnecting');
  }
}

// ---- Append Transcript Segment ----
function appendSegment(segment) {
  if (transcriptEmpty) {
    transcriptEmpty.style.display = 'none';
  }

  var div = document.createElement('div');
  div.className = 'live-transcript-segment';
  div.setAttribute('data-index', segment.segment_index);

  var timeStr = formatTimestamp(segment.timestamp_ms);
  div.innerHTML =
    '<span class="segment-time">' + escapeHtml(timeStr) + '</span>' +
    '<span class="segment-speaker">' + escapeHtml(segment.speaker || 'Speaker') + '</span>' +
    '<span class="segment-text">' + escapeHtml(segment.text) + '</span>';

  liveTranscript.appendChild(div);

  if (autoScroll) {
    liveTranscript.scrollTop = liveTranscript.scrollHeight;
  }
}

function formatTimestamp(ms) {
  if (!ms || ms < 0) ms = 0;
  var totalSecs = Math.floor(ms / 1000);
  var mins = Math.floor(totalSecs / 60);
  var secs = totalSecs % 60;
  return mins + ':' + (secs < 10 ? '0' : '') + secs;
}

// ---- Timer ----
function updateTimer() {
  var elapsed = Math.floor((Date.now() - recordingStart) / 1000);
  var hrs = Math.floor(elapsed / 3600);
  var mins = Math.floor((elapsed % 3600) / 60);
  var secs = elapsed % 60;

  if (hrs > 0) {
    liveTimer.textContent = hrs + ':' + (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
  } else {
    liveTimer.textContent = mins + ':' + (secs < 10 ? '0' : '') + secs;
  }
}

// ---- Status Indicator ----
function setStatus(status) {
  liveIndicator.className = 'live-indicator live-indicator--' + status;
  var labels = {
    live: 'Live',
    paused: 'Paused',
    reconnecting: 'Reconnecting...',
    disconnected: 'Disconnected'
  };
  liveStatusText.textContent = labels[status] || status;
}

// ---- Pause / Resume ----
pauseBtn.addEventListener('click', function() {
  if (!isPaused) {
    isPaused = true;
    // Stop current recording chunk early if active
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop(); // will trigger onstop → send partial chunk → wait
    }
    pauseBtn.textContent = 'Resume';
    setStatus('paused');
  } else {
    isPaused = false;
    pauseBtn.textContent = 'Pause';
    setStatus('live');
    // Restart chunk cycle
    captureOneChunk();
  }
});

// ---- Stop Meeting ----
stopBtn.addEventListener('click', async function() {
  if (!confirm('Stop this meeting? The transcript will be saved and action items extracted.')) {
    return;
  }
  await stopMeeting();
});

async function stopMeeting() {
  var sid = sessionId;
  isStopping = true;

  // Stop current recording — flush final chunk
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop(); // triggers onstop which sends the final partial chunk
  }

  // Small delay to let the final chunk POST complete
  await new Promise(function(resolve) { setTimeout(resolve, 500); });

  // Stop mic
  if (audioStream) {
    audioStream.getTracks().forEach(function(t) { t.stop(); });
    audioStream = null;
  }

  // Stop timer
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  // Stop memory hints
  if (memoryHintsInterval) {
    clearInterval(memoryHintsInterval);
    clearTimeout(memoryHintsInterval);
    memoryHintsInterval = null;
  }

  // Close SSE
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // Clear beforeunload guard
  sessionId = null;

  // Show processing phase
  sessionPhase.style.display = 'none';
  processingPhase.style.display = 'flex';

  if (!sid) {
    window.location.href = '/dashboard.html';
    return;
  }

  try {
    dbg('Stopping session:', sid);
    var res = await fetch('/api/live/' + sid + '/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      alert('Failed to save meeting. Your transcript segments are preserved.');
      window.location.href = '/dashboard.html';
      return;
    }

    var data = await res.json();
    dbg('Stop response:', data);

    if (data.meeting_id) {
      window.location.href = '/dashboard.html?view=' + data.meeting_id;
    } else {
      window.location.href = '/dashboard.html';
    }
  } catch (err) {
    alert('Something went wrong while saving. Please check your dashboard.');
    window.location.href = '/dashboard.html';
  }
}

// ---- Memory Hints ----
async function fetchMemoryHints() {
  if (!sessionId) return;

  try {
    var res = await fetch('/api/live/' + sessionId + '/memory-hints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!res.ok) return;
    var data = await res.json();

    if (data.hints && data.hints.length > 0) {
      memoryHintsSection.style.display = 'block';
      memoryHintsList.innerHTML = data.hints.map(function(hint) {
        var date = '';
        try {
          date = new Date(hint.date + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        } catch(e) {}

        return '<div class="memory-hint-card">' +
          '<div class="memory-hint-header">' +
            '<strong>' + escapeHtml(hint.title) + '</strong>' +
            (date ? '<span class="memory-hint-date">' + date + '</span>' : '') +
          '</div>' +
          '<div class="memory-hint-topics">' +
            hint.shared_topics.map(function(t) { return '<span class="insight-tag">' + escapeHtml(t) + '</span>'; }).join('') +
          '</div>' +
          '<div class="memory-hint-snippet">' + escapeHtml(hint.snippet) + '</div>' +
        '</div>';
      }).join('');
    }
  } catch (err) {
    // Non-critical — silently ignore
  }
}

// ---- Error Display ----
function showSetupError(msg) {
  setupError.textContent = msg;
  setupError.style.display = 'block';
}

function hideSetupError() {
  setupError.style.display = 'none';
}

// ---- Utility ----
function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
