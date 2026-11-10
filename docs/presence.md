# Кто чем занят (agent presence)

Статус: **не задеплоено**. Миграция `0006_agent_presence.sql` не применена, секрет `PRESENCE_TOKEN` не задан.

## Контракт

`POST /hub/api/presence` — отметка агента.
- Заголовок `Authorization: Bearer <токен>`; сравнение с секретом Worker `PRESENCE_TOKEN` через SHA-256 без раннего выхода (общий помощник `src/bearer.js`, тот же, что у `PUSH_DELIVERY_TOKEN`).
- Секрет не задан или короче 32 символов: 503 `{"error":"not_configured"}`. Токен неверный или отсутствует: 401. Тело больше 2 КБ, не JSON, неверное или лишнее поле: 400.
- Поля: `owner`, `agent` (`^[a-z0-9_-]{1,32}$`), `machine` (`^[A-Za-z0-9._-]{1,64}$`), `state` (`working|idle|blocked|done`), необязательные `card` (до 80 символов) и `note` (до 200); управляющие символы в них запрещены. Другие поля, в том числе `updated_at`, дают 400.
- Запись upsert по (owner, agent, machine); `updated_at` ставит сервер. Не больше 200 ключей: на 201-й новый ключ 409 `{"error":"too_many_agents"}` (существующие обновляются). Каждая запись удаляет строки старше 7 суток. Успех: 200 `{"ok":true}`.

`GET /hub/api/presence` — для владельца доски (сессия, как у `/hub/api/board`): 401 без сессии, 403 не владельцу. Массив строк за последние 24 часа, сортировка owner, agent, machine; `stale: true`, если отметке больше 15 минут. Bearer-токен на GET не принимается.

Другие методы: 405 с `allow: GET, POST`.

Панель «Кто чем занят» на `/hub/apps/board.html` над колонками читает GET раз в минуту.

## Клиент

`tools/hub-presence.py <state> [--card ..] [--note ..] [--agent ..] [--owner ..] [--machine ..] [--quiet-fail]`, только стандартная библиотека Python 3.9+, таймаут 5 секунд.
Окружение: `HUB_PRESENCE_URL` (полный адрес `.../hub/api/presence`), `HUB_PRESENCE_TOKEN` (значение секрета `PRESENCE_TOKEN`). Необязательно: `HUB_PRESENCE_OWNER`, `HUB_PRESENCE_AGENT`, `HUB_PRESENCE_MACHINE` вместо флагов (машина по умолчанию — имя хоста). Токен не печатается. С `--quiet-fail` любая ошибка даёт код 0 и одну строку в stderr.

## Подключение

Claude Code (`~/.claude/settings.json`, хуки не должны ронять агента, поэтому `--quiet-fail`):

```json
{"hooks": {
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "python3 ~/hub/tools/hub-presence.py working --agent claude --owner <owner> --quiet-fail"}]}],
  "Stop": [{"hooks": [{"type": "command", "command": "python3 ~/hub/tools/hub-presence.py idle --agent claude --owner <owner> --quiet-fail"}]}]
}}
```

Codex: вызывать из обёртки запуска или из `notify` в `~/.codex/config.toml` (не проверено в этой работе):

```sh
python3 ~/hub/tools/hub-presence.py working --agent codex --owner <owner> --card "$CARD" --quiet-fail
codex exec "$TASK"
python3 ~/hub/tools/hub-presence.py done --agent codex --owner <owner> --card "$CARD" --quiet-fail
```

Hermes (cron, раз в 5 минут, пока агент жив; без отметок строка через 15 минут становится приглушённой):

```cron
*/5 * * * * HUB_PRESENCE_URL=... HUB_PRESENCE_TOKEN=... python3 ~/hub/tools/hub-presence.py working --agent hermes --owner <owner> --quiet-fail
```

Значения `HUB_PRESENCE_URL` и `HUB_PRESENCE_TOKEN` задавать в окружении или в файле с правами 600, не в репозитории.

## Для выката (делает владелец, не этот PR)

1. Применить миграцию `0006` к D1.
2. Задать секрет `PRESENCE_TOKEN` (32+ символов) Worker'у.
3. Помнить: `deploy-worker.yml` из `main` затирает приватную прод-сборку (см. `CLAUDE.md`).
