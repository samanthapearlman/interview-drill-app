const PASSING_SCORE = 7;
const MIN_RECORDING_MS = 2000;
const ADMIN_PIN = '1234';

const STORAGE_KEYS = {
  adminPinOverride: 'admin_pin_override',
  decksOverride: 'decks_override',
  sessionHistory: 'session_history',
  workerUrl: 'worker_url',
};

const SCREENS = {
  admin: 'screen-admin',
  deckSelect: 'screen-deck-select',
  practice: 'screen-practice',
  summary: 'screen-summary',
};

const CARD_TYPES = ['opener', 'behavioral', 'star', 'closer', 'general'];

let decksData = { decks: [] };
let currentSession = null;
let currentSessionSummarySaved = false;
let pinCallback = null;

let mediaRecorder = null;
let activeStream = null;
let audioChunks = [];
let currentMimeType = '';
let recordingStartTime = 0;
let recordUiState = 'idle';
let pendingAudioBlob = null;
let pendingAudioMime = null;
let discardOnStop = false;

let adminExpandedDeckIds = new Set();
let adminSelection = null;
let adminDraft = null;

// ─── Helpers ───

function getAdminPin() {
  return localStorage.getItem(STORAGE_KEYS.adminPinOverride) || ADMIN_PIN;
}

function getWorkerUrl() {
  return localStorage.getItem(STORAGE_KEYS.workerUrl) || '';
}

function showScreen(screenId) {
  Object.values(SCREENS).forEach(function (id) {
    var section = document.getElementById(id);
    if (!section) return;
    var hidden = id !== screenId;
    section.classList.toggle('hidden', hidden);
    section.setAttribute('aria-hidden', String(hidden));
  });
}

function escapeHtml(value) {
  var div = document.createElement('div');
  div.textContent = value == null ? '' : value;
  return div.innerHTML;
}

function createTextElement(tagName, className, text) {
  var el = document.createElement(tagName);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

// ─── Deck Data ───

async function loadDecks() {
  var override = localStorage.getItem(STORAGE_KEYS.decksOverride);
  if (override) {
    try {
      decksData = JSON.parse(override);
      return decksData;
    } catch (e) {
      localStorage.removeItem(STORAGE_KEYS.decksOverride);
    }
  }
  var response = await fetch('data/decks.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('decks_load_failed');
  decksData = await response.json();
  return decksData;
}

function saveDecksOverride() {
  localStorage.setItem(STORAGE_KEYS.decksOverride, JSON.stringify(decksData));
}

function getDeckById(deckId) {
  return decksData.decks.find(function (d) { return d.id === deckId; }) || null;
}

// ─── Session History ───

function getSessionHistory() {
  var raw = localStorage.getItem(STORAGE_KEYS.sessionHistory);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    localStorage.removeItem(STORAGE_KEYS.sessionHistory);
    return [];
  }
}

function saveSessionToHistory() {
  if (!currentSession || currentSessionSummarySaved) return;
  var history = getSessionHistory();
  history.push({
    deckId: currentSession.deckId,
    results: currentSession.results.slice(),
    timestamp: Date.now(),
  });
  if (history.length > 50) history.splice(0, history.length - 50);
  localStorage.setItem(STORAGE_KEYS.sessionHistory, JSON.stringify(history));
  currentSessionSummarySaved = true;
}

function clearSessionHistory() {
  localStorage.removeItem(STORAGE_KEYS.sessionHistory);
}

// ─── Config Banner ───

function updateConfigBanner() {
  var banner = document.getElementById('config-banner');
  if (!banner) return;
  var hasUrl = Boolean(getWorkerUrl());
  banner.classList.toggle('hidden', hasUrl);
  resetRecordButton();
}

// ─── Inline Error ───

function showInlineError(message) {
  var el = document.getElementById('inline-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}

function clearInlineError() {
  var el = document.getElementById('inline-error');
  if (!el) return;
  el.textContent = '';
  el.classList.add('hidden');
}

// ─── Deck Select ───

function renderDeckSelect() {
  var list = document.getElementById('deck-list');
  if (!list) return;
  list.innerHTML = '';

  if (!decksData.decks.length) {
    var empty = createTextElement('p', 'text-muted', 'No decks found. Add one in Admin.');
    empty.style.padding = '20px';
    list.appendChild(empty);
    return;
  }

  decksData.decks.forEach(function (deck) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'deck-card';
    card.setAttribute('aria-label', 'Open ' + deck.name + ' deck');

    var name = createTextElement('div', 'deck-card-name', deck.name);
    var count = createTextElement('div', 'deck-card-count',
      deck.cards.length + ' card' + (deck.cards.length === 1 ? '' : 's'));

    card.append(name, count);
    card.addEventListener('click', function () { startSession(deck.id); });
    list.appendChild(card);
  });
}

// ─── PIN Modal ───

function showPinModal(onSuccess) {
  pinCallback = onSuccess;
  document.getElementById('pin-input').value = '';
  document.getElementById('pin-error').classList.add('hidden');
  document.getElementById('pin-modal').classList.remove('hidden');
  setTimeout(function () { document.getElementById('pin-input').focus(); }, 50);
}

function hidePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
  pinCallback = null;
}

function submitPin() {
  var input = document.getElementById('pin-input');
  var error = document.getElementById('pin-error');
  if (input.value === getAdminPin()) {
    var cb = pinCallback;
    hidePinModal();
    if (cb) cb();
    return;
  }
  error.classList.remove('hidden');
  input.value = '';
  input.focus();
}

// ─── Card Sequencing ───

function sequenceCards(deck) {
  var openers = deck.cards.filter(function (c) { return c.type === 'opener'; });
  var closers = deck.cards.filter(function (c) { return c.type === 'closer'; });
  var middle = deck.cards.filter(function (c) {
    return c.type !== 'opener' && c.type !== 'closer';
  });

  var shuffled = middle.map(function (c) {
    return { card: c, rand: Math.random() };
  }).sort(function (a, b) {
    var wa = Number(a.card.weight) || 1;
    var wb = Number(b.card.weight) || 1;
    return wb - wa || b.rand - a.rand;
  }).map(function (item) { return Object.assign({}, item.card); });

  return [].concat(
    openers.map(function (c) { return Object.assign({}, c); }),
    shuffled,
    closers.map(function (c) { return Object.assign({}, c); })
  );
}

// ─── Session ───

function startSession(deckId) {
  var deck = getDeckById(deckId);
  if (!deck || !deck.cards.length) return;

  cancelActiveRecording();
  clearInlineError();

  currentSession = {
    deckId: deckId,
    cards: sequenceCards(deck),
    currentIndex: 0,
    results: [],
    talkingPointVisibility: {},
  };
  currentSessionSummarySaved = false;

  renderPracticeCard();
  showScreen(SCREENS.practice);
}

function currentCard() {
  if (!currentSession) return null;
  return currentSession.cards[currentSession.currentIndex] || null;
}

function getSessionResult(cardId) {
  if (!currentSession) return null;
  return currentSession.results.find(function (r) { return r.cardId === cardId; }) || null;
}

function upsertSessionResult(nextResult) {
  var idx = currentSession.results.findIndex(function (r) {
    return r.cardId === nextResult.cardId;
  });
  if (idx >= 0) {
    currentSession.results[idx] = nextResult;
  } else {
    currentSession.results.push(nextResult);
  }
}

function removeSessionResult(cardId) {
  if (!currentSession) return;
  currentSession.results = currentSession.results.filter(function (r) {
    return r.cardId !== cardId;
  });
}

// ─── Practice Card Rendering ───

function renderPracticeCard() {
  var card = currentCard();
  if (!card) return;

  var total = currentSession.cards.length;
  var idx = currentSession.currentIndex;

  document.getElementById('progress-indicator').textContent =
    'Card ' + (idx + 1) + ' of ' + total;
  document.getElementById('practice-title').textContent = card.prompt;

  // Talking point toggle
  var tpBlock = document.getElementById('talking-point-block');
  var tpBtn = document.getElementById('btn-toggle-tp');
  var visible = currentSession.talkingPointVisibility[card.id] || false;

  tpBlock.textContent = card.target || '';
  tpBlock.classList.toggle('hidden', !visible);
  tpBtn.textContent = visible ? 'Hide talking point' : 'Show talking point';

  // Grade panel
  var result = getSessionResult(card.id);
  if (result) {
    showGradePanel(result.score, result.callouts);
  } else {
    hideGradePanel();
    resetRecordButton();
  }

  clearInlineError();
}

function showGradePanel(score, callouts) {
  var panel = document.getElementById('grade-panel');
  var recordArea = document.getElementById('record-area');

  document.getElementById('grade-score').textContent = score + ' / 10';

  var calloutList = document.getElementById('grade-callouts');
  calloutList.innerHTML = '';
  (callouts || []).forEach(function (text) {
    var li = document.createElement('li');
    li.textContent = text;
    calloutList.appendChild(li);
  });

  recordArea.classList.add('hidden');
  panel.classList.remove('hidden');
}

function hideGradePanel() {
  document.getElementById('grade-panel').classList.add('hidden');
  document.getElementById('record-area').classList.remove('hidden');
}

// ─── Recording ───

function resetRecordButton() {
  var btn = document.getElementById('btn-record');
  var label = document.getElementById('record-label');
  if (!btn || !label) return;

  var hasWorker = Boolean(getWorkerUrl());
  btn.disabled = !hasWorker;
  label.textContent = hasWorker ? 'Tap to record' : 'Configure Worker URL first';
  btn.classList.remove('recording');
  recordUiState = 'idle';
}

function setRecordingState() {
  var btn = document.getElementById('btn-record');
  var label = document.getElementById('record-label');
  btn.classList.add('recording');
  label.textContent = 'Recording... tap to stop';
  recordUiState = 'recording';
}

function setProcessingState() {
  var btn = document.getElementById('btn-record');
  var label = document.getElementById('record-label');
  btn.disabled = true;
  btn.classList.remove('recording');
  label.textContent = 'Processing...';
  recordUiState = 'processing';
}

async function toggleRecording() {
  if (recordUiState === 'processing') return;

  if (recordUiState === 'recording') {
    stopRecording();
    return;
  }

  // Start recording
  clearInlineError();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showInlineError('Audio recording not supported in this browser.');
    return;
  }

  var mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : null;

  if (!mime) {
    showInlineError('Audio recording not supported in this browser.');
    return;
  }

  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    activeStream = stream;
    currentMimeType = mime;
    audioChunks = [];
    discardOnStop = false;

    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = handleRecordingStop;

    mediaRecorder.start();
    recordingStartTime = Date.now();
    setRecordingState();
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      showInlineError('Microphone access required. Check browser settings.');
    } else {
      showInlineError('Could not start recording: ' + err.message);
    }
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (activeStream) {
    activeStream.getTracks().forEach(function (t) { t.stop(); });
    activeStream = null;
  }
}

function cancelActiveRecording() {
  discardOnStop = true;
  stopRecording();
  mediaRecorder = null;
  audioChunks = [];
  recordUiState = 'idle';
}

async function handleRecordingStop() {
  if (discardOnStop) {
    discardOnStop = false;
    return;
  }

  var durationMs = Date.now() - recordingStartTime;
  if (durationMs < MIN_RECORDING_MS) {
    showInlineError('Response too short. Try again.');
    resetRecordButton();
    return;
  }

  var blob = new Blob(audioChunks, { type: currentMimeType });
  pendingAudioBlob = blob;
  pendingAudioMime = currentMimeType;
  audioChunks = [];

  await processRecording(blob, currentMimeType);
}

// ─── API Calls ───

async function transcribe(audioBlob, mimeType) {
  var ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
  var formData = new FormData();
  formData.append('audio', audioBlob, 'recording.' + ext);

  var res = await fetch(getWorkerUrl() + '/transcribe', {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('transcription_failed');
  var data = await res.json();
  return data.transcript;
}

async function grade(transcript, card) {
  var res = await fetch(getWorkerUrl() + '/grade', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript: transcript,
      prompt: card.prompt,
      target: card.target,
      keyPoints: card.keyPoints,
    }),
  });
  if (!res.ok) throw new Error('grading_failed');
  return await res.json();
}

// ─── Process Recording ───

async function processRecording(blob, mimeType) {
  var card = currentCard();
  if (!card) return;

  setProcessingState();
  clearInlineError();

  try {
    var transcript = await transcribe(blob, mimeType);
    var result = await grade(transcript, card);

    upsertSessionResult({
      cardId: card.id,
      prompt: card.prompt,
      transcript: transcript,
      score: result.score,
      callouts: result.callouts,
    });

    showGradePanel(result.score, result.callouts);
    pendingAudioBlob = null;
    pendingAudioMime = null;
  } catch (err) {
    var msg = err.message === 'transcription_failed'
      ? 'Transcription failed. Tap to retry.'
      : err.message === 'grading_failed'
        ? 'Grading failed. Tap to retry.'
        : 'Connection lost. Tap to retry.';
    showInlineError(msg);
    resetRecordButton();

    // Override record button to retry with saved blob
    if (pendingAudioBlob) {
      var retryBtn = document.getElementById('btn-record');
      var retryLabel = document.getElementById('record-label');
      retryLabel.textContent = 'Tap to retry';
      retryBtn.disabled = false;
      retryBtn.onclick = async function () {
        retryBtn.onclick = null;
        await processRecording(pendingAudioBlob, pendingAudioMime);
      };
    }
  }
}

// ─── Next / Repeat ───

function handleSkip() {
  if (!currentSession) return;

  cancelActiveRecording();
  clearInlineError();

  if (currentSession.currentIndex >= currentSession.cards.length - 1) {
    saveSessionToHistory();
    renderSessionSummary();
    showScreen(SCREENS.summary);
    return;
  }

  currentSession.currentIndex++;
  hideGradePanel();
  resetRecordButton();
  renderPracticeCard();
}

function handleRepeat() {
  var card = currentCard();
  if (!card) return;

  removeSessionResult(card.id);
  hideGradePanel();
  resetRecordButton();
  clearInlineError();
}

function handleNext() {
  var card = currentCard();
  if (!card || !currentSession) return;

  var result = getSessionResult(card.id);
  if (result && result.score < PASSING_SCORE) {
    // Increment weight in the source deck
    var deck = getDeckById(currentSession.deckId);
    if (deck) {
      var sourceCard = deck.cards.find(function (c) { return c.id === card.id; });
      if (sourceCard) {
        sourceCard.weight = (Number(sourceCard.weight) || 1) + 1;
        saveDecksOverride();
      }
    }
  }

  // Advance or go to summary
  if (currentSession.currentIndex >= currentSession.cards.length - 1) {
    saveSessionToHistory();
    renderSessionSummary();
    showScreen(SCREENS.summary);
    return;
  }

  currentSession.currentIndex++;
  hideGradePanel();
  resetRecordButton();
  renderPracticeCard();
}

// ─── Session Summary ───

function renderSessionSummary() {
  var stats = document.getElementById('summary-stats');
  var flagged = document.getElementById('summary-flagged');
  if (!stats || !flagged || !currentSession) return;

  var results = currentSession.results;
  var totalCards = currentSession.cards.length;
  var scores = results.map(function (r) { return r.score; });
  var avg = scores.length ? (scores.reduce(function (a, b) { return a + b; }, 0) / scores.length) : 0;
  var flaggedCards = results.filter(function (r) { return r.score < PASSING_SCORE; });

  stats.innerHTML = '';
  stats.appendChild(createTextElement('p', 'summary-stat',
    'Cards practiced: ' + totalCards));
  stats.appendChild(createTextElement('p', 'summary-stat',
    'Average score: ' + avg.toFixed(1)));

  flagged.innerHTML = '';
  if (flaggedCards.length > 0) {
    flagged.appendChild(createTextElement('h3', 'summary-flagged-title',
      'Needs more reps'));
    var ul = document.createElement('ul');
    ul.className = 'summary-flagged-list';
    flaggedCards.forEach(function (r) {
      var li = document.createElement('li');
      li.textContent = r.prompt + ' (' + r.score + '/10)';
      ul.appendChild(li);
    });
    flagged.appendChild(ul);
  }
}

// ─── Admin: Tab Switching ───

function switchAdminTab(tab) {
  var tabDecks = document.getElementById('tab-decks');
  var tabSettings = document.getElementById('tab-settings');
  var panelDecks = document.getElementById('admin-decks-panel');
  var panelSettings = document.getElementById('admin-settings-panel');

  if (tab === 'decks') {
    tabDecks.classList.add('active');
    tabSettings.classList.remove('active');
    panelDecks.classList.remove('hidden');
    panelSettings.classList.add('hidden');
    renderAdminDecks();
  } else {
    tabSettings.classList.add('active');
    tabDecks.classList.remove('active');
    panelSettings.classList.remove('hidden');
    panelDecks.classList.add('hidden');
    renderAdminSettings();
  }
}

// ─── Admin: Decks Tab ───

function renderAdminDecks() {
  var container = document.getElementById('admin-deck-list');
  if (!container) return;
  container.innerHTML = '';

  decksData.decks.forEach(function (deck) {
    var deckEl = document.createElement('div');
    deckEl.className = 'admin-deck';

    // Deck header
    var header = document.createElement('div');
    header.className = 'admin-deck-header';

    var nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'admin-deck-name';
    nameBtn.textContent = deck.name + ' (' + deck.cards.length + ')';
    nameBtn.addEventListener('click', function () {
      if (adminExpandedDeckIds.has(deck.id)) {
        adminExpandedDeckIds.delete(deck.id);
      } else {
        adminExpandedDeckIds.add(deck.id);
      }
      renderAdminDecks();
    });

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'action-btn danger small';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', function () {
      var msg = deck.cards.length > 0
        ? 'Delete "' + deck.name + '" and its ' + deck.cards.length + ' cards?'
        : 'Delete "' + deck.name + '"?';
      if (!window.confirm(msg)) return;
      decksData.decks = decksData.decks.filter(function (d) { return d.id !== deck.id; });
      saveDecksOverride();
      adminExpandedDeckIds.delete(deck.id);
      renderAdminDecks();
    });

    header.append(nameBtn, deleteBtn);
    deckEl.appendChild(header);

    // Expanded cards
    if (adminExpandedDeckIds.has(deck.id)) {
      var cardList = document.createElement('div');
      cardList.className = 'admin-card-list';

      deck.cards.forEach(function (card, cardIndex) {
        var cardEl = document.createElement('div');
        cardEl.className = 'admin-card-item';

        // If this card is being edited
        if (adminSelection && adminSelection.deckId === deck.id && adminSelection.cardId === card.id) {
          cardEl.appendChild(renderCardEditor(deck, card, cardIndex));
        } else {
          var cardBtn = document.createElement('button');
          cardBtn.type = 'button';
          cardBtn.className = 'admin-card-btn';
          cardBtn.textContent = card.prompt || '(no prompt)';
          cardBtn.addEventListener('click', function () {
            adminSelection = { deckId: deck.id, cardId: card.id };
            adminDraft = Object.assign({}, card, {
              keyPoints: card.keyPoints ? card.keyPoints.slice() : [],
            });
            renderAdminDecks();
          });
          cardEl.appendChild(cardBtn);
        }

        cardList.appendChild(cardEl);
      });

      // Add card button
      var addCardBtn = document.createElement('button');
      addCardBtn.type = 'button';
      addCardBtn.className = 'action-btn secondary small';
      addCardBtn.textContent = '+ Add card';
      addCardBtn.addEventListener('click', function () {
        var newId = deck.id + '-card-' + Date.now();
        deck.cards.push({
          id: newId,
          type: 'general',
          prompt: '',
          target: '',
          keyPoints: [],
          weight: 1,
        });
        saveDecksOverride();
        adminSelection = { deckId: deck.id, cardId: newId };
        adminDraft = Object.assign({}, deck.cards[deck.cards.length - 1], {
          keyPoints: [],
        });
        renderAdminDecks();
      });
      cardList.appendChild(addCardBtn);

      deckEl.appendChild(cardList);
    }

    container.appendChild(deckEl);
  });
}

function renderCardEditor(deck, card, cardIndex) {
  var form = document.createElement('div');
  form.className = 'card-editor';

  // Type select
  var typeLabel = createTextElement('label', 'editor-label', 'Type');
  var typeSelect = document.createElement('select');
  typeSelect.className = 'editor-select';
  CARD_TYPES.forEach(function (t) {
    var opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    if (adminDraft.type === t) opt.selected = true;
    typeSelect.appendChild(opt);
  });
  typeSelect.addEventListener('change', function () { adminDraft.type = typeSelect.value; });

  // Prompt
  var promptLabel = createTextElement('label', 'editor-label', 'Prompt');
  var promptInput = document.createElement('input');
  promptInput.type = 'text';
  promptInput.className = 'editor-input';
  promptInput.value = adminDraft.prompt || '';
  promptInput.addEventListener('input', function () { adminDraft.prompt = promptInput.value; });

  // Target
  var targetLabel = createTextElement('label', 'editor-label', 'Target talking point');
  var targetArea = document.createElement('textarea');
  targetArea.className = 'editor-textarea';
  targetArea.rows = 4;
  targetArea.value = adminDraft.target || '';
  targetArea.addEventListener('input', function () { adminDraft.target = targetArea.value; });

  // Key points
  var kpLabel = createTextElement('label', 'editor-label', 'Key points');
  var kpContainer = document.createElement('div');
  kpContainer.className = 'kp-list';

  function renderKeyPoints() {
    kpContainer.innerHTML = '';
    (adminDraft.keyPoints || []).forEach(function (kp, kpIdx) {
      var row = document.createElement('div');
      row.className = 'kp-row';
      var kpInput = document.createElement('input');
      kpInput.type = 'text';
      kpInput.className = 'editor-input kp-input';
      kpInput.value = kp;
      kpInput.addEventListener('input', function () {
        adminDraft.keyPoints[kpIdx] = kpInput.value;
      });
      var removeKpBtn = document.createElement('button');
      removeKpBtn.type = 'button';
      removeKpBtn.className = 'kp-remove';
      removeKpBtn.textContent = 'x';
      removeKpBtn.addEventListener('click', function () {
        adminDraft.keyPoints.splice(kpIdx, 1);
        renderKeyPoints();
      });
      row.append(kpInput, removeKpBtn);
      kpContainer.appendChild(row);
    });

    var addKpBtn = document.createElement('button');
    addKpBtn.type = 'button';
    addKpBtn.className = 'action-btn secondary small';
    addKpBtn.textContent = '+ Add key point';
    addKpBtn.addEventListener('click', function () {
      adminDraft.keyPoints.push('');
      renderKeyPoints();
    });
    kpContainer.appendChild(addKpBtn);
  }
  renderKeyPoints();

  // Weight (read-only)
  var weightLabel = createTextElement('label', 'editor-label',
    'Weight: ' + (Number(card.weight) || 1));
  var resetWeightBtn = document.createElement('button');
  resetWeightBtn.type = 'button';
  resetWeightBtn.className = 'action-btn secondary small';
  resetWeightBtn.textContent = 'Reset to 1';
  resetWeightBtn.addEventListener('click', function () {
    card.weight = 1;
    adminDraft.weight = 1;
    saveDecksOverride();
    renderAdminDecks();
  });

  // Action buttons
  var actions = document.createElement('div');
  actions.className = 'editor-actions';

  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'action-btn primary small';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', function () {
    Object.assign(card, {
      type: adminDraft.type,
      prompt: adminDraft.prompt,
      target: adminDraft.target,
      keyPoints: adminDraft.keyPoints.slice(),
    });
    saveDecksOverride();
    closeCardEditor();
    renderAdminDecks();
  });

  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'action-btn secondary small';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', function () {
    closeCardEditor();
    renderAdminDecks();
  });

  var deleteCardBtn = document.createElement('button');
  deleteCardBtn.type = 'button';
  deleteCardBtn.className = 'action-btn danger small';
  deleteCardBtn.textContent = 'Delete card';
  deleteCardBtn.addEventListener('click', function () {
    if (!window.confirm('Delete this card?')) return;
    deck.cards.splice(cardIndex, 1);
    saveDecksOverride();
    closeCardEditor();
    renderAdminDecks();
  });

  actions.append(saveBtn, cancelBtn, deleteCardBtn);

  form.append(
    typeLabel, typeSelect,
    promptLabel, promptInput,
    targetLabel, targetArea,
    kpLabel, kpContainer,
    weightLabel, resetWeightBtn,
    actions
  );

  return form;
}

function closeCardEditor() {
  adminSelection = null;
  adminDraft = null;
}

// ─── Admin: Settings Tab ───

function renderAdminSettings() {
  var urlInput = document.getElementById('input-worker-url');
  if (urlInput) urlInput.value = getWorkerUrl();
}

function bindAdminSettings() {
  // Worker URL
  document.getElementById('btn-save-worker-url').addEventListener('click', function () {
    var val = document.getElementById('input-worker-url').value.trim();
    // Remove trailing slash
    if (val.endsWith('/')) val = val.slice(0, -1);
    localStorage.setItem(STORAGE_KEYS.workerUrl, val);
    updateConfigBanner();
  });

  // PIN change
  document.getElementById('btn-change-pin').addEventListener('click', function () {
    var current = document.getElementById('input-current-pin').value;
    var newPin = document.getElementById('input-new-pin').value;
    if (current !== getAdminPin()) {
      alert('Current PIN is incorrect.');
      return;
    }
    if (!newPin || newPin.length !== 4) {
      alert('New PIN must be 4 digits.');
      return;
    }
    localStorage.setItem(STORAGE_KEYS.adminPinOverride, newPin);
    document.getElementById('input-current-pin').value = '';
    document.getElementById('input-new-pin').value = '';
    alert('PIN updated.');
  });

  // Reset weights
  document.getElementById('btn-reset-weights').addEventListener('click', function () {
    if (!window.confirm('Reset all card weights to 1 across all decks?')) return;
    decksData.decks.forEach(function (deck) {
      deck.cards.forEach(function (card) { card.weight = 1; });
    });
    saveDecksOverride();
    alert('All weights reset to 1.');
  });

  // Clear history
  document.getElementById('btn-clear-history').addEventListener('click', function () {
    if (!window.confirm('Clear all session history?')) return;
    clearSessionHistory();
    alert('Session history cleared.');
  });
}

// ─── Global Event Binding ───

function bindGlobalEvents() {
  // Admin entry
  document.getElementById('btn-admin').addEventListener('click', function () {
    showPinModal(function () {
      switchAdminTab('decks');
      renderAdminDecks();
      showScreen(SCREENS.admin);
    });
  });

  // Admin back
  document.getElementById('btn-admin-back').addEventListener('click', function () {
    closeCardEditor();
    renderDeckSelect();
    showScreen(SCREENS.deckSelect);
  });

  // Back to decks from practice
  document.getElementById('btn-back-to-decks').addEventListener('click', function () {
    if (!window.confirm('Leave this session?')) return;
    cancelActiveRecording();
    currentSession = null;
    currentSessionSummarySaved = false;
    renderDeckSelect();
    showScreen(SCREENS.deckSelect);
  });

  // PIN modal
  document.getElementById('btn-pin-submit').addEventListener('click', submitPin);
  document.getElementById('btn-pin-cancel').addEventListener('click', hidePinModal);
  document.getElementById('pin-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitPin();
  });

  // Admin tabs
  document.getElementById('tab-decks').addEventListener('click', function () {
    switchAdminTab('decks');
  });
  document.getElementById('tab-settings').addEventListener('click', function () {
    switchAdminTab('settings');
  });

  // Talking point toggle
  document.getElementById('btn-toggle-tp').addEventListener('click', function () {
    var card = currentCard();
    if (!card || !currentSession) return;
    var visible = !currentSession.talkingPointVisibility[card.id];
    currentSession.talkingPointVisibility[card.id] = visible;
    var tpBlock = document.getElementById('talking-point-block');
    var tpBtn = document.getElementById('btn-toggle-tp');
    tpBlock.classList.toggle('hidden', !visible);
    tpBtn.textContent = visible ? 'Hide talking point' : 'Show talking point';
  });

  // Record button
  document.getElementById('btn-record').addEventListener('click', function () {
    toggleRecording();
  });

  // Repeat / Next / Skip
  document.getElementById('btn-repeat').addEventListener('click', handleRepeat);
  document.getElementById('btn-next').addEventListener('click', handleNext);
  document.getElementById('btn-skip').addEventListener('click', handleSkip);

  // Summary buttons
  document.getElementById('btn-practice-again').addEventListener('click', function () {
    if (currentSession) startSession(currentSession.deckId);
  });
  document.getElementById('btn-change-deck').addEventListener('click', function () {
    currentSession = null;
    currentSessionSummarySaved = false;
    renderDeckSelect();
    showScreen(SCREENS.deckSelect);
  });

  // Add deck
  document.getElementById('btn-add-deck').addEventListener('click', function () {
    var name = prompt('Deck name:');
    if (!name || !name.trim()) return;
    var id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
    decksData.decks.push({ id: id, name: name.trim(), cards: [] });
    saveDecksOverride();
    adminExpandedDeckIds.add(id);
    renderAdminDecks();
  });

  // Admin settings
  bindAdminSettings();
}

// ─── Initialization ───

document.addEventListener('DOMContentLoaded', async function () {
  try {
    await loadDecks();
  } catch (e) {
    console.error('Failed to load decks:', e);
  }

  renderDeckSelect();
  updateConfigBanner();
  bindGlobalEvents();
  showScreen(SCREENS.deckSelect);
});
