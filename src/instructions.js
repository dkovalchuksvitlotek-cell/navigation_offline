// Перетворення маршруту на покрокові голосові інструкції українською мовою.
//
// Кожен крок = «проїдьте ... і виконайте маневр». Водій підтверджує виконання
// маневру, і лише тоді озвучується наступний крок. Оскільки GPS немає,
// інструкції спираються на орієнтири, які водій може порахувати сам:
// номер перехрестя, назви вулиць, номер з'їзду з кільця.

import { FLAG_ROUNDABOUT } from './router.js';
import { turnDelta } from './geo.js';

const LOOK_DIST = 25; // м — відрізок для оцінки напрямку до/після вузла
const MAX_COUNTED_JUNCTIONS = 10;

// ---------------------------------------------------------------- мова

/** Відмінкові форми типів вулиць: знахідний (на ...), місцевий (по ...), родовий (у бік ...). */
const STREET_TYPES = {
  'вулиця': ['вулицю', 'вулиці', 'вулиці'],
  'площа': ['площу', 'площі', 'площі'],
  'алея': ['алею', 'алеї', 'алеї'],
  'набережна': ['набережну', 'набережній', 'набережної'],
  'дорога': ['дорогу', 'дорозі', 'дороги'],
  'траса': ['трасу', 'трасі', 'траси'],
  'проспект': ['проспект', 'проспекту', 'проспекту'],
  'бульвар': ['бульвар', 'бульвару', 'бульвару'],
  'провулок': ['провулок', 'провулку', 'провулка'],
  'узвіз': ['узвіз', 'узвозу', 'узвозу'],
  'шосе': ['шосе', 'шосе', 'шосе'],
  'майдан': ['майдан', 'майдані', 'майдану'],
  'тупик': ['тупик', 'тупику', 'тупика'],
  'проїзд': ['проїзд', 'проїзду', 'проїзду'],
  'міст': ['міст', 'мосту', 'мосту'],
  'тракт': ['тракт', 'тракту', 'тракту'],
  'спуск': ['спуск', 'спуску', 'спуску'],
};
const CASES = { acc: 0, loc: 1, gen: 2 };

// Прикметники в назвах («вулиця Соборна», «провулок Тихий», «Садова вулиця»).
// Відмінюємо лише однозначні закінчення: «-ова/-ева» не чіпаємо, бо так само
// закінчуються прізвища в родовому відмінку («вулиця Чехова»).
const ADJECTIVES = [
  // [закінчення, скільки літер відкинути, [знахідний, місцевий, родовий]]
  [/(ськ|цьк|зьк|[^аеиіоуяюь]н|ьн|ьов)а$/u, 1, ['у', 'ій', 'ої']], // Соборна, Київська, Польова
  [/[^аеиіоуяюь]ня$/u, 1, ['ю', 'ій', 'ьої']], // Верхня
  [/ий$/u, 2, ['ий', 'ому', 'ого']], // Тихий
  [/[^аеиіоуяю]ній$/u, 2, ['ій', 'ьому', 'ього']], // Крайній
];

// Поширені прикметники, які не розпізнаються за закінченням (див. коментар вище).
const FEMININE_ADJ_STEMS = new Set(['садов', 'лісов', 'вишнев', 'нов', 'парков', 'ринков',
  'березов', 'дубов', 'кленов', 'липов', 'тополев', 'яблунев', 'горіхов', 'бузков', 'степов',
  'торгов', 'промислов', 'шахтов', 'гаєв', 'велик', 'мал', 'стар', 'довг', 'широк', 'глибок',
  'висок', 'крут', 'тих', 'весел', 'золот', 'молод', 'руд', 'жовт', 'біл', 'чорн']);

function declineAdjective(word, kase) {
  if (/а$/u.test(word) && FEMININE_ADJ_STEMS.has(word.slice(0, -1).toLowerCase())) {
    return word.slice(0, -1) + ADJECTIVES[0][2][CASES[kase]];
  }
  for (const [re, cut, forms] of ADJECTIVES) {
    if (re.test(word)) return word.slice(0, -cut) + forms[CASES[kase]];
  }
  return null;
}

/** Назва вулиці у потрібному відмінку: знахідний (acc), місцевий (loc) чи родовий (gen). */
export function declineStreet(name, kase) {
  const words = name.split(/\s+/u);
  const lower = words.map((w) => w.toLowerCase());
  let typeAt = -1;
  if (STREET_TYPES[lower[0]]) typeAt = 0;
  else if (words.length > 1 && STREET_TYPES[lower[words.length - 1]]) typeAt = words.length - 1;
  if (typeAt < 0) return name;

  const out = [...words];
  out[typeAt] = STREET_TYPES[lower[typeAt]][CASES[kase]];
  const step = typeAt === 0 ? 1 : -1;
  for (let i = typeAt + step; i >= 0 && i < words.length; i += step) {
    const d = declineAdjective(words[i], kase);
    if (!d) break;
    out[i] = d;
  }
  return out.join(' ');
}

/** «на вулицю Шевченка» / «на дорогу без назви». */
function onto(name) {
  return name ? `на ${declineStreet(name, 'acc')}` : 'на дорогу без назви';
}

/** «по вулиці Шевченка» / «по дорозі без назви». */
function along(name) {
  return name ? `по ${declineStreet(name, 'loc')}` : 'по дорозі без назви';
}

export function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

/** Відстань словами з округленням, зручним для сприйняття на слух. */
export function formatDistance(m) {
  if (m < 1000) {
    const r = m < 100 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 50) * 50;
    if (r < 1000) return `${r} ${plural(r, 'метр', 'метри', 'метрів')}`;
    m = r;
  }
  const km = Math.round(m / 100) / 10;
  if (Number.isInteger(km)) return `${km} ${plural(km, 'кілометр', 'кілометри', 'кілометрів')}`;
  return `${String(km).replace('.', ',')} кілометра`;
}

const ORDINAL_LOC = ['', 'першому', 'другому', 'третьому', 'четвертому', "п'ятому",
  'шостому', 'сьомому', 'восьмому', "дев'ятому", 'десятому'];
const ORDINAL_ACC = ['', 'перший', 'другий', 'третій', 'четвертий', "п'ятий",
  'шостий', 'сьомий', 'восьмий', "дев'ятий", 'десятий'];

function junctionPhrase(k) {
  if (k === 1) return 'на найближчому перехресті';
  if (k <= MAX_COUNTED_JUNCTIONS) return `на ${ORDINAL_LOC[k]} перехресті`;
  return null;
}

const COMPASS = ['північ', 'північний схід', 'схід', 'південний схід',
  'південь', 'південний захід', 'захід', 'північний захід'];
export function compassWord(deg) {
  return COMPASS[Math.round(deg / 45) % 8];
}

const MANEUVER_TEXT = {
  'straight': 'продовжуйте рух прямо',
  'slight-right': 'плавно поверніть праворуч',
  'right': 'поверніть праворуч',
  'sharp-right': 'різко поверніть праворуч',
  'slight-left': 'плавно поверніть ліворуч',
  'left': 'поверніть ліворуч',
  'sharp-left': 'різко поверніть ліворуч',
  'uturn': 'розверніться',
  'keep-right': 'на розвилці тримайтеся праворуч',
  'keep-left': 'на розвилці тримайтеся ліворуч',
};

export const MANEUVER_ICON = {
  'depart': '⬆', 'straight': '⬆', 'arrive': '🏁', 'roundabout': '⟳',
  'slight-right': '⬈', 'right': '➡', 'sharp-right': '⬊',
  'slight-left': '⬉', 'left': '⬅', 'sharp-left': '⬋',
  'uturn': '↶', 'keep-right': '⬈', 'keep-left': '⬉',
};

function classifyTurn(delta) {
  const a = Math.abs(delta);
  const side = delta > 0 ? 'right' : 'left';
  if (a < 25) return 'straight';
  if (a < 60) return `slight-${side}`;
  if (a < 135) return side;
  if (a < 170) return `sharp-${side}`;
  return 'uturn';
}

// ---------------------------------------------------------------- геометрія маршруту

/** Точка маршруту приблизно за `dist` м до (dir=-1) або після (dir=+1) індексу p. */
function pathPointAt(graph, nodes, p, dir, dist = LOOK_DIST) {
  let acc = 0;
  let i = p;
  while (i + dir >= 0 && i + dir < nodes.length) {
    acc += graph.dist(nodes[i], nodes[i + dir]);
    i += dir;
    if (acc >= dist) break;
  }
  return nodes[i];
}

function turnAt(graph, nodes, p) {
  const before = pathPointAt(graph, nodes, p, -1);
  const after = pathPointAt(graph, nodes, p, +1);
  return turnDelta(graph.bearing(before, nodes[p]), graph.bearing(nodes[p], after));
}

/** Чи є у вузлі інша дозволена дорога майже прямо (тобто розвилка)? */
function hasCompetingStraight(graph, nodes, p, delta) {
  const before = pathPointAt(graph, nodes, p, -1);
  const inBearing = graph.bearing(before, nodes[p]);
  return graph.adj[nodes[p]].some((e) => {
    if (e.to === nodes[p - 1] || e.to === nodes[p + 1]) return false;
    const d = turnDelta(inBearing, graph.bearing(nodes[p], e.to));
    return Math.abs(d) < 40 && Math.abs(d - delta) > 5;
  });
}

function segmentKey(graph, wayIdx) {
  const w = graph.ways[wayIdx];
  return w.name >= 0 ? `n${w.name}` : `w${wayIdx}`;
}

// ---------------------------------------------------------------- побудова кроків

/**
 * @returns {Array<{
 *   type: 'turn'|'roundabout'|'arrive', maneuver: string, icon: string,
 *   startIdx: number, endIdx: number, maneuverIdx: number,
 *   distance: number,   // до точки маневру (озвучується)
 *   length: number,     // усього кроку (для кільця — разом із проїздом по колу)
 *   street: string|null, target: string|null,
 *   junction: number|null, crossings: string[],
 *   action: string, text: string,
 * }>}
 */
export function buildSteps(graph, route) {
  const { nodes, ways } = route;
  if (nodes.length < 2) {
    return [{
      type: 'arrive', maneuver: 'arrive', icon: MANEUVER_ICON.arrive,
      startIdx: 0, endIdx: 0, maneuverIdx: 0, distance: 0, length: 0, street: null, target: null,
      junction: null, crossings: [], action: 'ви вже на місці',
      text: 'Ви вже на місці призначення.',
    }];
  }

  const steps = [];
  let stepStart = 0;
  let street = graph.streetName(graph.ways[ways[0]].name);

  const close = (endIdx, fields) => {
    steps.push({ ...collectLeg(graph, route, stepStart, endIdx, street), ...fields });
  };

  const onRing = (i) => graph.ways[ways[i]].flags & FLAG_ROUNDABOUT;

  /** Крок «кільце» з в'їздом у вузлі маршруту e. Повертає індекс вузла виїзду. */
  const ringStep = (e) => {
    let x = e;
    let exits = 0;
    while (x < nodes.length - 1 && onRing(x)) {
      x++;
      if (graph.adj[nodes[x]].some((ed) => !(graph.ways[ed.way].flags & FLAG_ROUNDABOUT))) exits++;
    }
    const leaves = x < nodes.length - 1;
    const target = leaves ? graph.streetName(graph.ways[ways[x]].name) : null;
    const ord = ORDINAL_ACC[exits] || `${exits}-й`;
    const exitText = leaves ? ` оберіть ${ord} з'їзд ${onto(target)}` : ' їдьте до місця призначення';
    close(e, {
      type: 'roundabout', maneuver: 'roundabout', target, exit: exits,
      action: e === 0 ? `рухайтеся по кільцю та${exitText}` : `в'їдьте на кільце та${exitText}`,
    });
    // Крок охоплює і проїзд по колу; наступний починається з виїзду з кільця.
    const step = steps[steps.length - 1];
    for (let i = e; i < x; i++) step.length += graph.dist(nodes[i], nodes[i + 1]);
    step.endIdx = x;
    stepStart = x;
    street = target;
    return x;
  };

  let e = 1; // індекс вузла маршруту, що розглядається як можлива точка маневру
  if (onRing(0)) e = ringStep(0) + 1;
  while (e < nodes.length - 1) {
    const inWay = ways[e - 1];
    const outWay = ways[e];
    const inRound = onRing(e - 1);
    const outRound = onRing(e);

    if (!inRound && outRound) {
      e = ringStep(e) + 1;
      continue;
    }

    if (inRound) { e++; continue; }

    const sameStreet = segmentKey(graph, inWay) === segmentKey(graph, outWay);
    const delta = turnAt(graph, nodes, e);
    const kind = classifyTurn(delta);
    const fork = kind === 'straight' && hasCompetingStraight(graph, nodes, e, delta);

    if (kind === 'straight' && !fork) { e++; continue; }
    if (!graph.isJunction(nodes[e]) && kind !== 'uturn') {
      e++; // вигин дороги без перехрестя — водієві нема з чого обирати
      continue;
    }

    const maneuver = fork ? (delta >= 0 ? 'keep-right' : 'keep-left') : kind;
    const target = graph.streetName(graph.ways[outWay].name);
    const action = maneuver === 'uturn' || sameStreet
      ? MANEUVER_TEXT[maneuver]
      : `${MANEUVER_TEXT[maneuver]} ${onto(target)}`;
    close(e, { type: 'turn', maneuver, target, action });
    stepStart = e;
    street = target;
    e++;
  }

  close(nodes.length - 1, {
    type: 'arrive', maneuver: 'arrive', target: null,
    action: 'ви прибудете до місця призначення',
  });

  steps.forEach((s, i) => {
    s.icon = MANEUVER_ICON[s.maneuver] || '⬆';
    s.text = composeText(graph, route, s, i === 0);
  });
  return steps;
}

/** Відстань, кількість перехресть і назви поперечних вулиць на ділянці маршруту. */
function collectLeg(graph, route, startIdx, endIdx, street) {
  const { nodes } = route;
  let distance = 0;
  let passed = 0;
  const crossings = [];
  for (let i = startIdx; i < endIdx; i++) {
    distance += graph.dist(nodes[i], nodes[i + 1]);
    const v = nodes[i + 1];
    if (i + 1 < endIdx && graph.isJunction(v)) {
      passed++;
      crossings.push(crossName(graph, route, i + 1));
    }
  }
  return {
    startIdx, endIdx, maneuverIdx: endIdx, distance, length: distance, street, crossings,
    junction: graph.isJunction(nodes[endIdx]) ? passed + 1 : null,
  };
}

/** Назва вулиці, яку перетинаємо у вузлі маршруту p (крім тих, якими їдемо). */
function crossName(graph, route, p) {
  const own = new Set([graph.ways[route.ways[p - 1]].name, graph.ways[route.ways[p]]?.name]);
  const other = graph.namesAt(route.nodes[p]).filter((n) => !own.has(n));
  return other.length ? other.map((n) => graph.names[n]).join(' / ') : 'без назви';
}

function composeText(graph, route, step, first) {
  const parts = [];
  if (first && step.distance > 0) {
    const { nodes } = route;
    const ahead = pathPointAt(graph, nodes, 0, +1, 60);
    const dir = compassWord(graph.bearing(nodes[0], ahead));
    let depart = `Рушайте ${along(step.street)} на ${dir}`;
    const toward = towardName(graph, route, step);
    if (toward) depart += `, у бік ${declineStreet(toward, 'gen')}`;
    parts.push(`${depart}.`);
  }
  const dist = formatDistance(step.distance);
  if (step.distance < 15) {
    parts.push(`${capitalize(step.action)}.`);
  } else if (step.type === 'arrive') {
    parts.push(`Через ${dist} ${step.action}.`);
  } else {
    const where = step.type === 'turn' && step.junction ? junctionPhrase(step.junction) : null;
    parts.push(`Через ${dist}${where ? `, ${where},` : ''} ${step.action}.`);
  }
  return parts.join(' ');
}

/** Найближча поперечна вулиця попереду — орієнтир для вибору напрямку руху на старті. */
function towardName(graph, route, step) {
  const own = graph.ways[route.ways[0]].name;
  for (let i = step.startIdx + 1; i <= step.endIdx; i++) {
    if (i < step.endIdx && !graph.isJunction(route.nodes[i])) continue;
    const other = graph.namesAt(route.nodes[i]).find((n) => n !== own);
    if (other !== undefined) return graph.names[other];
  }
  return null;
}

/** Додаткова фраза, коли наступний маневр зовсім близько. */
export function followUpHint(next) {
  if (!next || next.distance >= 80) return '';
  if (next.type === 'arrive') return ' Одразу після цього ви будете на місці.';
  return ` Одразу після цього ${next.action}.`;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
