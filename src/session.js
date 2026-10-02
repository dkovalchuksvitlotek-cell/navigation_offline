// Стан покрокової навігації: який крок озвучено і що робити після підтвердження водія.

import { buildSteps, followUpHint, capitalize } from './instructions.js';
import { FLAG_ROUNDABOUT } from './router.js';

export class NavSession {
  /**
   * @param {import('./router.js').Graph} graph
   * @param {number} from — початковий вузол
   * @param {number} to — вузол призначення
   */
  constructor(graph, from, to, opts = {}) {
    this.graph = graph;
    this.to = to;
    this.plan(from, opts);
  }

  plan(from, opts = {}) {
    const route = this.graph.route(from, this.to, opts);
    if (!route) throw new Error('Маршрут не знайдено: точки не з’єднані дорогами з урахуванням одностороннього руху.');
    this.from = from;
    this.route = route;
    this.steps = buildSteps(this.graph, route);
    this.index = 0;
    this.finished = false;
  }

  get step() {
    return this.steps[this.index];
  }

  get isLast() {
    return this.index === this.steps.length - 1;
  }

  /** Залишок шляху від початку поточного кроку, м. */
  get remaining() {
    return this.steps.slice(this.index).reduce((s, x) => s + x.length, 0);
  }

  /** Текст для озвучування поточного кроку. */
  announcement() {
    if (this.finished) return 'Ви прибули до місця призначення. Гарної дороги!';
    return this.step.text + followUpHint(this.steps[this.index + 1]);
  }

  /** Водій підтвердив виконання поточного кроку. Повертає текст для озвучування. */
  done() {
    if (this.finished) return this.announcement();
    if (this.isLast) this.finished = true;
    else this.index++;
    return this.announcement();
  }

  back() {
    if (this.finished) this.finished = false;
    else if (this.index > 0) this.index--;
    return this.announcement();
  }

  /**
   * Водій проґавив маневр поточного кроку і поїхав прямо.
   * Вважаємо, що він доїхав до наступного перехрестя, і будуємо новий маршрут звідти.
   */
  missed() {
    const { nodes } = this.route;
    const s = this.step;
    if (s.type === 'arrive') {
      return 'Місце призначення залишилося позаду. Розверніться, коли це буде безпечно, і поверніться назад.';
    }
    const via = nodes[s.endIdx];
    if (s.type === 'roundabout') {
      // Проґавили з'їзд — водій лишився на кільці, тож продовжуємо рух по колу.
      const { ways } = this.graph;
      this.plan(via, { firstEdge: (e) => ways[e.way].flags & FLAG_ROUNDABOUT });
      return `Маршрут перебудовано. ${this.announcement()}`;
    }
    const before = nodes[s.endIdx - 1];
    const { node, prevNode } = this.graph.continueStraight(before, via);
    this.plan(node, { firstEdge: (e) => e.to !== prevNode });
    return `Маршрут перебудовано. Вважаю, що ви проїхали прямо до наступного перехрестя. ${this.announcement()}`;
  }

  /** Почати заново з іншої точки (водій вказав, де він зараз). */
  restartFrom(node) {
    this.plan(node);
    return `Маршрут перебудовано. ${this.announcement()}`;
  }

  /** Короткий текст для екрана (без вступу «Рушайте…»). */
  headline() {
    if (this.finished) return 'Ви на місці';
    return capitalize(this.step.action);
  }

  toJSON() {
    return { from: this.from, to: this.to, index: this.index, finished: this.finished };
  }
}
