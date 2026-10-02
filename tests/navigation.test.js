import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Graph } from '../src/router.js';
import { buildSteps, formatDistance, declineStreet } from '../src/instructions.js';
import { NavSession } from '../src/session.js';

const graph = new Graph(JSON.parse(fs.readFileSync(new URL('../data/demo.json', import.meta.url))));

function corner(a, b) {
  const ia = graph.names.indexOf(a);
  const ib = graph.names.indexOf(b);
  assert.ok(ia >= 0 && ib >= 0, `немає вулиць ${a} / ${b}`);
  const hit = graph.crossStreets(ia).find((c) => c.idx === ib);
  assert.ok(hit, `${a} не перетинає ${b}`);
  return hit.node;
}

test('формат відстані з правильними відмінками', () => {
  assert.equal(formatDistance(7), '10 метрів');
  assert.equal(formatDistance(21), '20 метрів');
  assert.equal(formatDistance(320), '300 метрів');
  assert.equal(formatDistance(1000), '1 кілометр');
  assert.equal(formatDistance(1260), '1,3 кілометра');
  assert.equal(formatDistance(3000), '3 кілометри');
  assert.equal(formatDistance(21000), '21 кілометр');
});

test('відмінювання назв вулиць', () => {
  assert.equal(declineStreet('вулиця Шевченка', 'acc'), 'вулицю Шевченка');
  assert.equal(declineStreet('вулиця Соборна', 'loc'), 'вулиці Соборній');
  assert.equal(declineStreet('вулиця Садова', 'gen'), 'вулиці Садової');
  assert.equal(declineStreet('вулиця Чехова', 'loc'), 'вулиці Чехова');
  assert.equal(declineStreet('провулок Тихий', 'loc'), 'провулку Тихому');
  assert.equal(declineStreet('Садова вулиця', 'acc'), 'Садову вулицю');
  assert.equal(declineStreet('проспект Незалежності', 'loc'), 'проспекту Незалежності');
  assert.equal(declineStreet('Хрещатик', 'acc'), 'Хрещатик');
});

test('маршрут враховує односторонній рух', () => {
  const from = corner('вулиця Садова', 'вулиця Мазепи');
  const to = corner('вулиця Шевченка', 'вулиця Мазепи');
  const r = graph.route(from, to);
  const mazepa = graph.names.indexOf('вулиця Мазепи');
  // Мазепи — лише на північ, тож їхати нею на південь не можна.
  r.ways.forEach((w, i) => {
    if (graph.ways[w].name === mazepa) {
      assert.ok(graph.lat[r.nodes[i + 1]] > graph.lat[r.nodes[i]], 'рух по Мазепи на південь');
    }
  });
  const back = graph.route(to, from);
  assert.ok(back.length < r.length, 'на північ має бути коротше');
});

test('кроки: рахунок перехресть, кільце, прибуття', () => {
  const from = corner('вулиця Шевченка', 'вулиця Січових Стрільців');
  const to = corner('вулиця Садова', 'вулиця Київська');
  const steps = buildSteps(graph, graph.route(from, to));
  assert.match(steps[0].text, /^Рушайте по вулиці Січових Стрільців на північ, у бік проспекту Незалежності\./);
  assert.match(steps[0].text, /на найближчому перехресті, поверніть праворуч на проспект Незалежності/);
  const ring = steps.find((s) => s.type === 'roundabout');
  assert.ok(ring, 'має бути крок з кільцем');
  assert.equal(ring.exit, 2);
  assert.match(ring.text, /оберіть другий з'їзд/);
  assert.ok(ring.length > ring.distance, 'довжина кроку з кільцем включає проїзд по колу');
  const left = steps.find((s) => s.target === 'вулиця Київська');
  assert.equal(left.maneuver, 'left');
  assert.equal(left.junction, 4);
  assert.match(left.text, /на четвертому перехресті, поверніть ліворуч на вулицю Київську/);
  assert.equal(steps.at(-1).type, 'arrive');
  const total = steps.reduce((s, x) => s + x.length, 0);
  assert.ok(Math.abs(total - graph.route(from, to).length) < 1);
});

test('сесія: виконано / назад / завершення', () => {
  const s = new NavSession(graph, corner('вулиця Соборна', 'вулиця Грушевського'),
    corner('вулиця Соборна', 'вулиця Вишнева'));
  assert.equal(s.steps.length, 1);
  assert.match(s.announcement(), /ви прибудете до місця призначення/);
  assert.match(s.done(), /Ви прибули/);
  assert.ok(s.finished);
  s.back();
  assert.ok(!s.finished);
});

test('сесія: пропущений поворот перебудовує маршрут від наступного перехрестя', () => {
  const from = corner('вулиця Шевченка', 'вулиця Січових Стрільців');
  const to = corner('вулиця Садова', 'вулиця Київська');
  const s = new NavSession(graph, from, to);
  const turnNode = s.route.nodes[s.step.endIdx];
  const text = s.missed();
  assert.match(text, /Маршрут перебудовано/);
  assert.notEqual(s.from, turnNode);
  // Проїхали прямо по Січових Стрільців — тепер на перехресті з вулицею Соборною.
  assert.equal(s.from, corner('вулиця Січових Стрільців', 'вулиця Соборна'));
  assert.equal(s.index, 0);
  // Новий маршрут не починається з розвороту назад.
  assert.notEqual(s.route.nodes[1], turnNode);
});

test('проґавлений з\'їзд з кільця: новий маршрут починається на кільці й називає з\'їзд', () => {
  const s = new NavSession(graph, corner('вулиця Шевченка', 'вулиця Мазепи'),
    corner('вулиця Садова', 'вулиця Героїв України'));
  while (s.step.type !== 'roundabout') s.done();
  s.missed();
  assert.equal(s.steps[0].type, 'roundabout');
  assert.match(s.steps[0].text, /^Рухайтеся по кільцю та оберіть \S+ з'їзд на /);
  assert.ok(graph.ways[s.route.ways[0]].flags & 4, 'першим ребром лишаємося на кільці');
  assert.ok(s.steps.length >= 2);
});
