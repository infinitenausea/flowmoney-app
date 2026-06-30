/**
 * FlowMoney — Реактивный Store на базе Proxy (спека 2.1)
 *
 * Использование:
 *   store.subscribe('weeklyLimit', (val) => updateDOM(val));
 *   store.state.weeklyLimit = 5000; // автоматически вызовет подписчика
 *
 * Подписки по ключу: только нужный узел DOM обновляется,
 * без тяжёлого Virtual DOM diffing.
 */

const Store = (() => {
  // Начальное состояние
  const _initialState = {
    // Пользователь
    currency: '₽',

    // Бюджет
    weeklyLimit:  0,
    monthlyLimit: 0,

    // Ввод
    inputAmount:     '',
    selectedCategory: null,

    // Данные
    categories:   [],
    transactions: [],

    // Синхронизация
    pendingSync:  [],
    isOnline:     navigator.onLine,

    // Аналитика — период
    analyticsPeriod: 'month',          // 'day' | 'month' | 'custom'
    analyticsRange:  { start: null, end: null }, // Unix-timestamps (ms)
  };

  // Реестр подписчиков: { 'ключ': [fn, fn, ...] }
  const _subscribers = {};

  /**
   * Уведомить всех подписчиков конкретного ключа.
   */
  function _notify(key, value) {
    const fns = _subscribers[key];
    if (!fns) return;
    for (let i = 0; i < fns.length; i++) {
      try {
        fns[i](value, key);
      } catch (e) {
        console.error(`[Store] subscriber error for key "${key}":`, e);
      }
    }
  }

  /**
   * Создаём глубокий Proxy с перехватом set.
   * Вложенные объекты тоже оборачиваются в Proxy,
   * чтобы мутации типа store.state.categories.push() тоже работали.
   */
  function _makeProxy(target, rootKey) {
    return new Proxy(target, {
      set(obj, prop, value) {
        const old = obj[prop];
        if (old === value) return true; // нет изменений — не шумим

        obj[prop] = value;

        // rootKey позволяет нотифицировать по корневому ключу
        // при мутациях вложенных объектов
        _notify(rootKey || prop, value);
        if (rootKey) _notify(prop, value); // также по sub-ключу

        return true;
      },
      get(obj, prop) {
        const val = obj[prop];
        // Проксируем вложенные объекты/массивы (не функции, не примитивы)
        if (val !== null && typeof val === 'object' && typeof prop === 'string') {
          return _makeProxy(val, prop);
        }
        return val;
      },
    });
  }

  const _state = { ..._initialState };
  const state = _makeProxy(_state, null);

  return {
    state,

    /**
     * Подписаться на изменение конкретного ключа.
     * @param {string} key
     * @param {Function} fn — получает (newValue, key)
     * @returns {Function} unsubscribe
     */
    subscribe(key, fn) {
      if (!_subscribers[key]) _subscribers[key] = [];
      _subscribers[key].push(fn);

      // Сразу вызываем с текущим значением
      fn(_state[key], key);

      return () => {
        _subscribers[key] = _subscribers[key].filter(f => f !== fn);
      };
    },

    /**
     * Пакетное обновление без множественных нотификаций.
     * @param {Object} partial — объект с обновляемыми полями
     */
    batchUpdate(partial) {
      const keys = Object.keys(partial);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (_state[k] !== partial[k]) {
          _state[k] = partial[k];
        }
      }
      // Нотифицируем один раз после всех изменений
      for (let i = 0; i < keys.length; i++) {
        _notify(keys[i], _state[keys[i]]);
      }
    },

    /**
     * Сбросить состояние к начальному.
     */
    reset() {
      this.batchUpdate({ ..._initialState });
    },

    /** Только для отладки в консоли */
    _dump() {
      return JSON.parse(JSON.stringify(_state));
    },
  };
})();

// Экспортируем в глобальный скоуп (без сборщика)
window.Store = Store;
