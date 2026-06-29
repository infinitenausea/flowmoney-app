# FlowMoney: System State & Development Roadmap

## 📊 Текущий статус проекта
* **Архитектурный паттерн:** Clean Architecture (Monolith) / Vanilla SPA[cite: 2]
* **Состояние инфраструктуры:** Docker-compose (Go + Postgres) развернут, Fail-Fast конфиг проверен, Graceful Shutdown работает.
* **Единый источник правды:** `spec.md`

---

## 🗺 Поэтапный план разработки (Roadmap)

### Этап 1: Слой данных & Безопасность (Бэкенд)
* [x] **1.1. Миграции и sqlc:** Создание таблиц (`users`, `categories`, `transactions`, `budgets`) по спеке[cite: 1] + генерация Go-кода через `sqlc`.
* [x] **1.2. Валидация Telegram:** Реализация `pkg/tgauth` (проверка HMAC-SHA256 подписи `initData`[cite: 1]).
* [x] **1.3. Auth Middleware:** Интеграция валидации в HTTP-пайплайн, проброс `telegram_id` в контекст запроса[cite: 1].

### Этап 2: Идемпотентный API Синхронизации (Бэкенд)
* [x] **2.1. GET /api/v1/bootstrap:** Хэндлер начальной загрузки состояния пользователя[cite: 1].
* [x] **2.2. POST /api/v1/sync:** Реализация `INSERT ... ON CONFLICT DO UPDATE` логики для оффлайн-пакетов транзакций клиента[cite: 1].
* [x] **2.3. GET /api/v1/analytics/*:** Эндпоинты `timeline` и `donut` (с агрегацией в SQL)[cite: 1].

### Этап 3: Каркас фронтенда & Telegram SDK (Фронтенд)
* [x] **3.1. SPA & Router:** Настройка структуры файлов без фреймворков, переключение вкладок, инициализация `window.Telegram.WebApp`[cite: 2].
* [x] **3.2. Theme Engine:** Маппинг CSS-переменных на `themeParams`, бесшовная смена тем (Light/Dark)[cite: 2].
* [x] **3.3. Реактивный Store:** Реализация Vanilla JS Store на базе `Proxy` для точечных мутаций DOM[cite: 2].

### Этап 4: Экраны ввода и Offline-First хранилище (Фронтенд)
* [x] **4.1. Главный экран & Кастомный NumPad:** Верстка интерфейса ввода, блокировка системной клавиатуры, Haptic Feedback на `pointerdown`[cite: 2]. Лимит суммы 999999, защита от двойной точки и ведущего нуля.
* [x] **4.2. Local Storage Manager:** `storage.js` — `saveTransactionLocally`, `getUnsyncedTransactions`, `markAsSynced`, `deleteLocally`. UUID v4 генерируется на клиенте через `self.crypto.randomUUID()`[cite: 2].
* [x] **4.3. Очередь синхронизации (Background Sync):** `sync.js` — воркер с интервалом 15 с + `window.addEventListener('online')`. UI не блокируется при ошибках сети[cite: 2].

### Этап 5: Аналитика, Свайпы и Настройки
* [x] **5.1. Нативный SVG-Donut:** `js/charts.js` — stroke-dasharray donut без библиотек; тап по сектору фильтрует таймлайн через Store[cite: 2].
* [x] **5.2. Touch-трекер для свайпов:** `js/gestures.js` — pointer-event delegation; свайп влево (мягкое удаление + коллапс), вправо (дублирование); физика сопротивления у краев; iOS WebKit safe[cite: 1, 2].
* [x] **5.3. Настройки бюджетов:** `js/settings.js` — слайдеры → Store → localStorage → best-effort PUT /api/v1/budgets; прогресс-бары недели/месяца; `dailyAvailable` вычисляется локально[cite: 2].

---

## 📈 Лог токен-затрат (Token-Saving Ledger)
* *Сессия 0 (Инициализация каркаса):* Claude 3.5 Sonnet (Medium Effort). Затраты: Минимальные. Результат: 100% чистая компиляция.
* *Сессия 1 (Этап 3 — Frontend Skeleton):* Claude Sonnet 4.6. Создан `frontend/` (index.html, css/style.css, js/store.js, js/app.js). Proxy-реактивность протестирована (3/3 assertions pass). HTTP-сервер запущен на :8080.
* *Сессия 2 (Этап 4 — Offline-First):* Claude Sonnet 4.6. Созданы `js/storage.js` и `js/sync.js`. Машина состояний транзакций: `_pending: true` → `synced: true`. NumPad лимит 999999. `handleAddTransaction` переведён на `StorageManager`.
* *Сессия 3 (Этап 5 — Analytics, Swipes, Settings):* Claude Sonnet 4.6. Созданы `js/charts.js`, `js/gestures.js`, `js/settings.js`. Исправлен парсинг bootstrap-ответа (data.budget.*). `dailyAvailable` вычисляется клиентски через Settings.computeDailyAvailable(). Слайдерные биндинги перенесены из app.js в settings.js.