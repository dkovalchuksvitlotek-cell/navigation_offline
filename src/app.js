import { Graph } from './router.js';
import { NavSession } from './session.js';
import { formatDistance, capitalize, plural } from './instructions.js';
import { MapView } from './mapview.js';
import { Voice, Commands, MediaButtons } from './speech.js';
import { saveMap, loadSavedMap, clearSavedMap, saveTrip, loadTrip } from './storage.js';

const $ = (sel, root = document) => root.querySelector(sel);
const DEMO_URL = 'data/demo.json';

const state = {
  graph: null,
  points: { from: -1, to: -1 },
  picking: null, // 'from' | 'to' під час вибору на карті
  session: null,
  navPicking: false,
};

const voice = new Voice();
const handlers = {
  done: () => navDone(),
  back: () => navBack(),
  repeat: () => navRepeat(),
  missed: () => navMissed(),
  error: (e) => showVoiceWarning(`Голосові команди недоступні (${e}).`),
};
const commands = new Commands(handlers);
const media = new MediaButtons(handlers);
let wakeLock = null;
let planMap;
let navMap;

// ------------------------------------------------------------------ карта

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  bindPlanUi();
  bindNavUi();
  bindSettings();

  let data = null;
  try { data = await loadSavedMap(); } catch { /* IndexedDB недоступна */ }
  try {
    setGraph(data ? new Graph(data) : await Graph.load(DEMO_URL));
  } catch (e) {
    showError(e.message);
    return;
  }
  offerResume();
}

function setGraph(graph) {
  state.graph = graph;
  state.points = { from: -1, to: -1 };
  $('#map-name').textContent = graph.name;
  $('#streets').replaceChildren(...graph.streetList().map((s) => new Option(s.name)));
  document.querySelectorAll('.point').forEach((fs) => {
    $('.street', fs).value = '';
    resetCross(fs);
    $('.chosen', fs).textContent = '';
  });
  if (planMap) planMap.setGraph(graph);
  else planMap = new MapView($('#map'), graph, { onTap: onPlanTap });
  if (navMap) navMap.setGraph(graph);
  else navMap = new MapView($('#nav-map'), graph, { onTap: onNavTap });
  planMap.setRoute(null);
  $('#summary').hidden = true;
  updateBuildButton();
}

// ------------------------------------------------------------------ вибір точок

function bindPlanUi() {
  document.querySelectorAll('.point').forEach((fs) => {
    const key = fs.dataset.point;
    $('.street', fs).addEventListener('change', () => onStreetChosen(fs));
    $('.cross', fs).addEventListener('change', (e) => {
      const node = Number(e.target.value);
      if (e.target.value !== '') setPoint(key, node);
      else onStreetChosen(fs);
    });
    $('.pick', fs).addEventListener('click', () => startPicking(key));
  });
  $('#swap').addEventListener('click', () => {
    const { from, to } = state.points;
    const [a, b] = document.querySelectorAll('.point');
    const va = $('.street', a).value;
    $('.street', a).value = $('.street', b).value;
    $('.street', b).value = va;
    resetCross(a);
    resetCross(b);
    setPoint('from', to);
    setPoint('to', from);
  });
  $('#build').addEventListener('click', buildRoute);
  $('#start').addEventListener('click', startNavigation);
}

function streetIndexByName(name) {
  return state.graph.names.findIndex((n) => n.toLowerCase() === name.trim().toLowerCase());
}

function resetCross(fs) {
  delete fs.dataset.street;
  const sel = $('.cross', fs);
  sel.replaceChildren(new Option('— перехрестя з… —', ''));
  sel.disabled = true;
}

function onStreetChosen(fs) {
  const g = state.graph;
  const idx = streetIndexByName($('.street', fs).value);
  // «change» повторно спрацьовує при втраті фокусу — не скидаємо вже вибране перехрестя.
  if (idx >= 0 && fs.dataset.street === String(idx)) return;
  resetCross(fs);
  if (idx >= 0) fs.dataset.street = String(idx);
  if (idx < 0) {
    setPoint(fs.dataset.point, -1);
    return;
  }
  const sel = $('.cross', fs);
  g.crossStreets(idx).forEach((c) => sel.append(new Option(c.name, c.node)));
  sel.disabled = sel.options.length <= 1;
  setPoint(fs.dataset.point, g.streetCenter(idx));
}

function startPicking(key) {
  state.picking = key;
  const hint = $('#pick-hint');
  hint.textContent = key === 'from' ? 'Торкніться карти: звідки їдемо' : 'Торкніться карти: куди їдемо';
  hint.hidden = false;
  $('#map').scrollIntoView({ behavior: 'smooth' });
}

function onPlanTap(lat, lon) {
  if (!state.picking) return;
  const node = state.graph.nearestNode(lat, lon);
  const key = state.picking;
  state.picking = null;
  $('#pick-hint').hidden = true;
  const fs = $(`.point[data-point="${key}"]`);
  const names = state.graph.namesAt(node).map((i) => state.graph.names[i]);
  $('.street', fs).value = names[0] || '';
  resetCross(fs);
  setPoint(key, node);
}

function describeNode(node) {
  const names = state.graph.namesAt(node).map((i) => state.graph.names[i]);
  if (!names.length) return 'Дорога без назви';
  if (names.length === 1) return names[0];
  return `Перехрестя: ${names.join(' × ')}`;
}

function setPoint(key, node) {
  state.points[key] = node;
  const fs = $(`.point[data-point="${key}"]`);
  $('.chosen', fs).textContent = node >= 0 ? describeNode(node) : '';
  planMap?.setMarker(key, node);
  $('#summary').hidden = true;
  planMap?.setRoute(null);
  updateBuildButton();
}

function updateBuildButton() {
  const { from, to } = state.points;
  $('#build').disabled = from < 0 || to < 0;
}

// ------------------------------------------------------------------ маршрут

function buildRoute() {
  hideError();
  try {
    state.session = new NavSession(state.graph, state.points.from, state.points.to);
  } catch (e) {
    showError(e.message);
    return;
  }
  renderSummary();
}

function renderSummary() {
  const s = state.session;
  const mins = Math.max(1, Math.round(s.route.time / 60));
  $('#summary-title').textContent =
    `${capitalize(formatDistance(s.route.length))} · ≈ ${mins} хв · ${s.steps.length} ${plural(s.steps.length, 'крок', 'кроки', 'кроків')}`;
  $('#steps').replaceChildren(...s.steps.map((st) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="ic"></span><span></span>';
    li.firstChild.textContent = st.icon;
    li.lastChild.textContent = st.text;
    return li;
  }));
  $('#summary').hidden = false;
  planMap.setRoute(s.route);
  planMap.fitNodes(s.route.nodes);
}

// ------------------------------------------------------------------ навігація

function bindNavUi() {
  $('#nav-done').addEventListener('click', navDone);
  $('#nav-back').addEventListener('click', navBack);
  $('#nav-repeat').addEventListener('click', navRepeat);
  $('#nav-missed').addEventListener('click', navMissed);
  $('#nav-here').addEventListener('click', () => {
    state.navPicking = !state.navPicking;
    $('#nav-pick-hint').hidden = !state.navPicking;
    if (state.navPicking) voice.speak('Торкніться карти там, де ви зараз.');
  });
  $('#nav-exit').addEventListener('click', () => {
    if (!state.session.finished && !confirm('Завершити навігацію?')) return;
    stopNavigation();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#nav-screen').hidden || e.target.closest?.('input, select, textarea, dialog')) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); navDone(); }
    else if (e.key === 'Backspace') { e.preventDefault(); navBack(); }
    else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') navRepeat();
  });
}

async function startNavigation() {
  $('#plan-screen').hidden = true;
  $('#nav-screen').hidden = false;
  navMap.setRoute(state.session.route);
  navMap.setMarker('to', state.session.to);
  renderNav();
  voice.speak(state.session.announcement());

  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* не критично */ }
  if ($('#opt-media').checked) media.start().catch(() => {});
  if ($('#opt-voice').checked) commands.start();
}

function stopNavigation() {
  voice.stop();
  commands.stop();
  media.stop();
  wakeLock?.release?.();
  wakeLock = null;
  saveTrip(null);
  $('#nav-screen').hidden = true;
  $('#plan-screen').hidden = false;
  planMap.resize();
}

function renderNav() {
  const s = state.session;
  saveTrip({ ...s.toJSON(), map: state.graph.name });
  const step = s.step;
  $('#nav-icon').textContent = s.finished ? '🏁' : step.icon;
  $('#nav-headline').textContent = s.headline();
  $('#nav-progress').textContent = s.finished
    ? 'Маршрут завершено'
    : `Крок ${s.index + 1} з ${s.steps.length} · залишилось ${formatDistance(s.remaining)}`;

  const detail = [];
  if (!s.finished) {
    detail.push(`через ${formatDistance(step.distance)}`);
    if (step.junction && step.type === 'turn') detail.push(`${step.junction}-е перехрестя`);
    if (step.type === 'roundabout') detail.push(`${step.exit}-й з'їзд`);
  }
  $('#nav-detail').textContent = capitalize(detail.join(' · '));
  $('#nav-text').textContent = s.announcement();
  $('#nav-crossings').textContent = !s.finished && step.crossings.length
    ? `Дорогою перетнете: ${step.crossings.join(' → ')}`
    : '';
  $('#nav-done').textContent = s.finished ? '✓ Завершити' : '✓ Виконано';
  $('#nav-back').disabled = s.index === 0 && !s.finished;

  if (s.finished) {
    navMap.setHighlight(null);
    navMap.setMarker('step', -1);
  } else {
    navMap.setHighlight([step.startIdx, step.endIdx]);
    navMap.setMarker('step', s.route.nodes[step.maneuverIdx]);
  }
}

function inNav() {
  return state.session && !$('#nav-screen').hidden;
}

function navDone() {
  if (!inNav()) return;
  if (state.session.finished) { stopNavigation(); return; }
  const text = state.session.done();
  renderNav();
  voice.speak(text);
  navigator.vibrate?.(40);
}

function navBack() {
  if (!inNav()) return;
  const text = state.session.back();
  renderNav();
  voice.speak(text);
}

function navRepeat() {
  if (!inNav()) return;
  voice.speak(state.session.announcement());
}

function navMissed() {
  if (!inNav() || state.session.finished) return;
  try {
    const text = state.session.missed();
    navMap.setRoute(state.session.route);
    renderNav();
    voice.speak(text);
  } catch (e) {
    voice.speak('Не вдалося перебудувати маршрут. Вкажіть на карті, де ви зараз.');
    $('#nav-crossings').textContent = e.message;
  }
}

function onNavTap(lat, lon) {
  if (!state.navPicking) return;
  state.navPicking = false;
  $('#nav-pick-hint').hidden = true;
  const node = state.graph.nearestNode(lat, lon);
  try {
    const text = state.session.restartFrom(node);
    navMap.setRoute(state.session.route);
    renderNav();
    voice.speak(text);
  } catch (e) {
    voice.speak('Звідси маршрут не знайдено. Спробуйте іншу точку.');
  }
}

// ------------------------------------------------------------------ відновлення поїздки

function offerResume() {
  const trip = loadTrip();
  if (!trip || trip.map !== state.graph.name || trip.from >= state.graph.size || trip.to >= state.graph.size) return;
  $('#resume').hidden = false;
  $('#resume-btn').onclick = () => {
    $('#resume').hidden = true;
    try {
      state.session = new NavSession(state.graph, trip.from, trip.to);
      state.session.index = Math.min(trip.index, state.session.steps.length - 1);
      state.session.finished = trip.finished;
      setPoint('from', trip.from);
      setPoint('to', trip.to);
      renderSummary();
      startNavigation();
    } catch (e) {
      showError(e.message);
    }
  };
  $('#resume-drop').onclick = () => { $('#resume').hidden = true; saveTrip(null); };
}

// ------------------------------------------------------------------ налаштування

function bindSettings() {
  const dlg = $('#settings');
  $('#menu-btn').addEventListener('click', () => {
    if (!voice.available) showVoiceWarning('Цей браузер не підтримує синтез мовлення.');
    else if (!voice.hasUkrainian) showVoiceWarning('Український голос не знайдено. Встановіть його в налаштуваннях синтезу мовлення телефона (Android: Налаштування → Мова → Синтез мовлення → Google → Українська).');
    dlg.showModal();
  });
  $('#rate').addEventListener('input', (e) => { voice.rate = Number(e.target.value); });
  $('#opt-voice').disabled = !commands.supported;
  $('#opt-media').disabled = !media.supported;

  $('#map-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const graph = new Graph(data);
      await saveMap(data).catch(() => {});
      setGraph(graph);
      dlg.close();
    } catch (err) {
      showVoiceWarning(`Не вдалося прочитати карту: ${err.message}`);
    }
  });
  $('#map-reset').addEventListener('click', async () => {
    await clearSavedMap().catch(() => {});
    setGraph(await Graph.load(DEMO_URL));
    dlg.close();
  });
}

function showVoiceWarning(msg) {
  const el = $('#voice-warning');
  el.textContent = msg;
  el.hidden = false;
}

function showError(msg) {
  const el = $('#error');
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  $('#error').hidden = true;
}

init();
