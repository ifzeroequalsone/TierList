// Scryfall Tier List Creator
// Populate a card pool from a Scryfall search query or link, then drag cards into tiers.

const STORAGE_KEY = 'scryfall_tierlist_v1';
const MAX_CARDS = 300;

const DEFAULT_TIERS = [
  { id: 's', label: 'S', color: '#ff5252' },
  { id: 'a', label: 'A', color: '#ff9800' },
  { id: 'b', label: 'B', color: '#ffca28' },
  { id: 'c', label: 'C', color: '#8bc34a' },
  { id: 'd', label: 'D', color: '#29b6f6' },
  { id: 'f', label: 'F', color: '#7e57c2' },
];

function defaultState() {
  return {
    query: '',
    tiers: DEFAULT_TIERS.map(t => ({ ...t })),
    cards: [],       // [{id, name, img}]
    placements: {},  // { cardId: tierId }  (absent/null = pool)
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

let state = loadState();
let selectedCardId = null;

// ── Helpers ──────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showStatus(msg, type = '') {
  const el = document.getElementById('tl-status');
  el.textContent = msg;
  el.className = 'tl-status' + (type ? ` ${type}` : '');
}

function showToast(msg, type = 'success') {
  const t = document.getElementById('tl-toast');
  t.textContent = msg;
  t.style.background = type === 'error' ? 'var(--red)' : type === 'warn' ? 'var(--orange)' : 'var(--green)';
  t.classList.add('show');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Query parsing ───────────────────────────────────────
function parseQuery(input) {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (/(^|\.)scryfall\.com$/.test(url.hostname)) {
      const q = url.searchParams.get('q');
      if (q) return q;
    }
  } catch {
    // not a URL — treat as raw Scryfall query syntax
  }
  return trimmed;
}

function slimCard(c) {
  const img = c.image_uris?.small
    ?? c.card_faces?.[0]?.image_uris?.small
    ?? '';
  const imgLarge = c.image_uris?.normal
    ?? c.card_faces?.[0]?.image_uris?.normal
    ?? img;
  return { id: c.id, name: c.name, img, imgLarge };
}

const REQUEST_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request to Scryfall timed out. Check your connection (or try disabling any ad-blocker/VPN) and try again.');
    }
    throw new Error('Could not reach Scryfall. Check your connection (or try disabling any ad-blocker/VPN) and try again.');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllCards(query) {
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&unique=cards&order=name`;
  const collected = [];
  let totalAvailable = 0;
  let page = 0;

  while (url && collected.length < MAX_CARDS && page < 8) {
    const res = await fetchWithTimeout(url);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.details || `Scryfall error (${res.status})`);
    }
    if (page === 0) totalAvailable = data.total_cards ?? data.data.length;
    collected.push(...data.data);
    url = data.has_more ? data.next_page : null;
    page++;
    if (url && collected.length < MAX_CARDS) await sleep(100);
  }

  const capped = totalAvailable > collected.length || collected.length > MAX_CARDS;
  const sliced = collected.slice(0, MAX_CARDS).map(slimCard);
  return { cards: sliced, totalAvailable, capped };
}

// ── Loading ──────────────────────────────────────────
async function handleLoad() {
  const input = document.getElementById('tl-query').value;
  const query = parseQuery(input);
  if (!query) { showStatus('Enter a Scryfall query or link first.', 'warn'); return; }

  const btn = document.getElementById('tl-load-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  showStatus('Fetching cards from Scryfall…');

  try {
    const { cards, totalAvailable, capped } = await fetchAllCards(query);
    if (cards.length === 0) {
      showStatus('No cards found for that query.', 'warn');
      return;
    }
    state.query = input.trim();
    state.cards = cards;
    state.placements = {};
    selectedCardId = null;
    persist();
    renderAll();
    showStatus(
      capped
        ? `Loaded ${cards.length} of ${totalAvailable} matching cards (refine your query to see more).`
        : `Loaded ${cards.length} card${cards.length !== 1 ? 's' : ''}.`,
      'success'
    );
  } catch (err) {
    showStatus(err.message || 'Failed to load cards.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load Cards';
  }
}

// ── Placement ────────────────────────────────────────
function placeCard(cardId, tierId) {
  if (tierId) state.placements[cardId] = tierId;
  else delete state.placements[cardId];
  persist();
  renderAll();
}

// ── Tier management ──────────────────────────────────
function addTier() {
  state.tiers.push({ id: uid(), label: 'New', color: '#90a4ae' });
  persist();
  renderAll();
}

function removeTier(tierId) {
  const hasCards = Object.values(state.placements).includes(tierId);
  if (hasCards && !confirm('This tier has cards in it. Remove it and send those cards back to the pool?')) return;
  state.tiers = state.tiers.filter(t => t.id !== tierId);
  Object.keys(state.placements).forEach(cid => {
    if (state.placements[cid] === tierId) delete state.placements[cid];
  });
  persist();
  renderAll();
}

function moveTier(tierId, dir) {
  const idx = state.tiers.findIndex(t => t.id === tierId);
  const newIdx = idx + dir;
  if (idx < 0 || newIdx < 0 || newIdx >= state.tiers.length) return;
  [state.tiers[idx], state.tiers[newIdx]] = [state.tiers[newIdx], state.tiers[idx]];
  persist();
  renderAll();
}

function renameTier(tierId, label) {
  const tier = state.tiers.find(t => t.id === tierId);
  if (tier) { tier.label = label; persist(); }
}

function recolorTier(tierId, color) {
  const tier = state.tiers.find(t => t.id === tierId);
  if (tier) { tier.color = color; persist(); renderAll(); }
}

// ── Rendering ────────────────────────────────────────
function cardEl(c) {
  return `<div class="tl-card${selectedCardId === c.id ? ' selected' : ''}" draggable="true" data-card-id="${c.id}" title="${esc(c.name)}">
    <img src="${c.img}" alt="${esc(c.name)}" loading="lazy" crossorigin="anonymous">
  </div>`;
}

function renderBoard() {
  document.getElementById('tl-board').innerHTML = state.tiers.map((tier, i) => {
    const cards = state.cards.filter(c => state.placements[c.id] === tier.id);
    return `
      <div class="tl-tier" style="--tier-color:${tier.color}">
        <div class="tl-tier-label">
          <input class="tl-tier-name" value="${esc(tier.label)}" data-tier-id="${tier.id}" placeholder="Label">
          <div class="tl-tier-controls">
            <button class="tl-tier-up" data-tier-id="${tier.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="tl-tier-down" data-tier-id="${tier.id}" title="Move down" ${i === state.tiers.length - 1 ? 'disabled' : ''}>↓</button>
            <input type="color" class="tl-tier-color" data-tier-id="${tier.id}" value="${tier.color}" title="Tier color">
            <button class="tl-tier-remove" data-tier-id="${tier.id}" title="Remove tier">✕</button>
          </div>
        </div>
        <div class="tl-tier-body" data-drop="tier:${tier.id}">
          ${cards.map(cardEl).join('')}
        </div>
      </div>`;
  }).join('');
}

function renderPool() {
  const poolCards = state.cards.filter(c => !state.placements[c.id]);
  document.getElementById('tl-pool-count').textContent = `(${poolCards.length})`;
  const pool = document.getElementById('tl-pool');
  pool.innerHTML = poolCards.length
    ? poolCards.map(cardEl).join('')
    : `<div class="empty-state tl-empty"><p>${state.cards.length ? 'All cards placed! 🎉' : 'Load a Scryfall query above to populate the pool.'}</p></div>`;
}

function renderAll() {
  renderBoard();
  renderPool();
}

// ── Export ───────────────────────────────────────────
async function exportPNG() {
  if (typeof html2canvas === 'undefined') {
    showToast('Export library failed to load — check your connection.', 'error');
    return;
  }
  const btn = document.getElementById('tl-export-btn');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Exporting…';
  try {
    const canvas = await html2canvas(document.getElementById('tl-board'), {
      backgroundColor: '#ffffff',
      useCORS: true,
      scale: 2,
    });
    const link = document.createElement('a');
    link.download = 'tier-list.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch (err) {
    showToast('Export failed. Some card images may not allow export.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

// ── Reset ────────────────────────────────────────────
function resetAll() {
  if (!confirm('Reset the tier list? This clears the loaded cards, tiers, and placements.')) return;
  state = defaultState();
  selectedCardId = null;
  persist();
  document.getElementById('tl-query').value = '';
  renderAll();
  showStatus('');
  showToast('Tier list reset.');
}

// ── Hover preview ──────────────────────────────────────
let previewCardId = null;

function positionPreview(x, y) {
  const preview = document.getElementById('tl-preview');
  const margin = 18;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = preview.offsetWidth || 260;
  const ph = preview.offsetHeight || 360;
  let left = x + margin;
  let top = y + margin;
  if (left + pw > vw) left = x - pw - margin;
  if (top + ph > vh) top = vh - ph - margin;
  if (top < margin) top = margin;
  if (left < margin) left = margin;
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}

function showPreview(card, x, y) {
  const id = card.dataset.cardId;
  const cardData = state.cards.find(c => c.id === id);
  if (!cardData) return;
  const preview = document.getElementById('tl-preview');
  if (previewCardId !== id) {
    const img = preview.querySelector('img');
    img.src = cardData.imgLarge || cardData.img;
    img.alt = cardData.name;
    previewCardId = id;
  }
  preview.classList.add('show');
  positionPreview(x, y);
}

function hidePreview() {
  previewCardId = null;
  document.getElementById('tl-preview').classList.remove('show');
}

document.addEventListener('mouseover', e => {
  const card = e.target.closest('.tl-card');
  if (!card) return;
  showPreview(card, e.clientX, e.clientY);
});

document.addEventListener('mousemove', e => {
  if (!previewCardId) return;
  const card = e.target.closest('.tl-card');
  if (!card || card.dataset.cardId !== previewCardId) { hidePreview(); return; }
  positionPreview(e.clientX, e.clientY);
});

document.addEventListener('mouseout', e => {
  const card = e.target.closest('.tl-card');
  if (!card) return;
  if (e.relatedTarget && card.contains(e.relatedTarget)) return;
  hidePreview();
});

// ── Drag & drop + click-to-place (event delegation) ───
function zoneTierId(zone) {
  const val = zone?.dataset.drop;
  if (!val || val === 'pool') return null;
  return val.slice('tier:'.length);
}

document.addEventListener('dragstart', e => {
  const card = e.target.closest('.tl-card');
  if (!card) return;
  hidePreview();
  e.dataTransfer.setData('text/plain', card.dataset.cardId);
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => card.classList.add('tl-dragging'));
});

document.addEventListener('dragend', e => {
  const card = e.target.closest('.tl-card');
  if (card) card.classList.remove('tl-dragging');
});

document.addEventListener('dragover', e => {
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.add('tl-drop-hover');
});

document.addEventListener('dragleave', e => {
  const zone = e.target.closest('[data-drop]');
  if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove('tl-drop-hover');
});

document.addEventListener('drop', e => {
  const zone = e.target.closest('[data-drop]');
  if (!zone) return;
  e.preventDefault();
  zone.classList.remove('tl-drop-hover');
  const cardId = e.dataTransfer.getData('text/plain');
  if (!cardId) return;
  placeCard(cardId, zoneTierId(zone));
});

document.addEventListener('click', e => {
  const card = e.target.closest('.tl-card');
  const zone = e.target.closest('[data-drop]');

  if (card) {
    const id = card.dataset.cardId;
    if (selectedCardId && selectedCardId !== id) {
      const targetZone = card.closest('[data-drop]');
      placeCard(selectedCardId, zoneTierId(targetZone));
      selectedCardId = null;
    } else {
      selectedCardId = selectedCardId === id ? null : id;
      renderAll();
    }
    return;
  }

  if (zone && selectedCardId) {
    placeCard(selectedCardId, zoneTierId(zone));
    selectedCardId = null;
  }
});

// ── Tier control events (delegated) ───────────────────
document.addEventListener('click', e => {
  const upBtn = e.target.closest('.tl-tier-up');
  const downBtn = e.target.closest('.tl-tier-down');
  const removeBtn = e.target.closest('.tl-tier-remove');
  if (upBtn) moveTier(upBtn.dataset.tierId, -1);
  else if (downBtn) moveTier(downBtn.dataset.tierId, 1);
  else if (removeBtn) removeTier(removeBtn.dataset.tierId);
});

document.addEventListener('change', e => {
  if (e.target.matches('.tl-tier-name')) {
    renameTier(e.target.dataset.tierId, e.target.value.trim() || 'Tier');
  } else if (e.target.matches('.tl-tier-color')) {
    recolorTier(e.target.dataset.tierId, e.target.value);
  }
});

// ── Boot ─────────────────────────────────────────────
document.getElementById('tl-load-btn').addEventListener('click', handleLoad);
document.getElementById('tl-query').addEventListener('keydown', e => { if (e.key === 'Enter') handleLoad(); });
document.getElementById('tl-add-tier-btn').addEventListener('click', addTier);
document.getElementById('tl-export-btn').addEventListener('click', exportPNG);
document.getElementById('tl-reset-btn').addEventListener('click', resetAll);

document.getElementById('tl-query').value = state.query;
renderAll();
if (state.cards.length) showStatus(`${state.cards.length} card${state.cards.length !== 1 ? 's' : ''} loaded.`, 'success');
