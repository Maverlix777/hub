# Кто чем занят (agent presence)

Изменение #1505 добавляет чтение presence по Bearer и команду `list` в исходном коде. В рамках #1505 оно **не выкатывалось**. Текущее состояние production, миграции `0006_agent_presence.sql` и секрета `PRESENCE_TOKEN` в этой работе не проверялось.

## Контракт

`POST /hub/api/presence` — отметка агента.
- Заголовок `Authorization: Bearer <токен>`; сравнение с секретом Worker `PRESENCE_TOKEN` через SHA-256 без раннего выхода (общий помощник `src/bearer.js`, тот же, что у `PUSH_DELIVERY_TOKEN`).
- Секрет не задан или короче 32 символов: 503 `{"error":"not_configured"}`. Токен неверный или отсутствует: 401. Тело больше 2 КБ, не JSON, неверное или лишнее поле: 400.
- Поля: `owner`, `agent` (`^[a-z0-9_-]{1,32}$`), `machine` (`^[A-Za-z0-9._-]{1,64}$`), `state` (`working|idle|blocked|done`), необязательные `card` (до 80 символов) и `note` (до 200); управляющие символы в них запрещены. Другие поля, в том числе `updated_at`, дают 400.
- Запись upsert по (owner, agent, machine); `updated_at` ставит сервер. Не больше 200 ключей: на 201-й новый ключ 409 `{"error":"too_many_agents"}` (существующие обновляются). Каждая запись удаляет строки старше 7 суток. Успех: 200 `{"ok":true}`.

`GET /hub/api/presence` возвращает массив строк за последние 24 часа, сортировка owner, agent, machine; `stale: true`, если отметке больше 15 минут. Чтение разрешено владельцу доски по сессии либо по тому же Bearer-токену `PRESENCE_TOKEN`.

| Авторизация GET | Ответ |
| --- | --- |
| Сессия владельца, с Bearer или без него | 200, массив |
| Верный Bearer при настроенном секрете, без сессии или с чужой сессией | 200, массив |
| Нет сессии и нет верного Bearer | 401 |
| Чужая сессия и нет верного Bearer | 403 |

Отсутствующий или короткий серверный секрет не даёт доступ по Bearer; для GET действуют те же 401/403, а сессия владельца продолжает работать. Новый 503 для GET не вводится. Неверный Bearer не отменяет действующую сессию владельца. POST остаётся только Bearer: его проверка настройки секрета и ответ 503 не меняются.

Другие методы: 405 с `allow: GET, POST`.

Код панели «Кто чем занят» на `/hub/apps/board.html` над колонками запрашивает GET раз в минуту; это описание исходного кода, а не подтверждение текущего live-выката.

## Клиент

Клиент использует только стандартную библиотеку Python 3.9+, общий таймаут 5 секунд и `User-Agent: hub-presence/1`.

- `tools/hub-presence.py <state> [--card ..] [--note ..] [--agent ..] [--owner ..] [--machine ..] [--quiet-fail]` отправляет прежний POST для `working`, `idle`, `blocked`, `done`. Успех не выводит тело ответа.
- `tools/hub-presence.py list [--quiet-fail]` отправляет GET без тела. `owner`, `agent` и `machine` ему не нужны. Успех — HTTP 200 с JSON-массивом, включая `[]`; stdout содержит этот массив одной JSON-строкой.

Обе команды требуют `HUB_PRESENCE_URL` (полный адрес `.../hub/api/presence`) и `HUB_PRESENCE_TOKEN` в окружении. Для POST необязательны `HUB_PRESENCE_OWNER`, `HUB_PRESENCE_AGENT`, `HUB_PRESENCE_MACHINE` вместо флагов; машина по умолчанию — имя хоста.

Токен не печатается. Перед выводом `list` проверяет декодированный ответ, включая вложенные строки и ключи: если в нём встретился настроенный токен, клиент завершается с безопасной ошибкой без вывода массива. Неверный JSON, ответ другого типа, HTTP-ошибка и ошибка транспорта дают одну безопасную строку в stderr и код 1; тело сервера и текст исключения не выводятся. `--quiet-fail` работает до или после команды: при ошибке код 0 и одна строка stderr; успешный `list` по-прежнему выводит массив.

Пример из корня репозитория, если URL и токен уже безопасно заданы в окружении:

```sh
python3 tools/hub-presence.py list
python3 tools/hub-presence.py --quiet-fail list
```

Локальная проверка клиента без live-сервиса и настоящего токена:

```sh
python3 -B -m unittest discover -s tools -p test_hub_presence.py -v
```

Тесты используют loopback HTTP и mocks с синтетическими данными. Они не устанавливают хуки, не меняют Keychain и не подтверждают production-доступ.

## Примеры подключения

Ниже — ручные примеры; в рамках #1505 они не применялись. URL и токен заранее задаются в окружении процесса, без токена в строке команды.

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
*/5 * * * * python3 ~/hub/tools/hub-presence.py working --agent hermes --owner <owner> --quiet-fail
```

Вызывающий процесс получает токен из своего защищённого хранилища (Keychain, если применимо) и передаёт его через окружение; CLI сам Keychain не читает. Токен нельзя сохранять в файлы, репозиторий или командную строку.

## Перед отдельным выкатом

1. Проверить состояние миграции `0006` в D1 и применить её, если ещё не применена.
2. Проверить наличие настроенного секрета `PRESENCE_TOKEN` (32+ символов), не печатая его значение.
3. Помнить: `deploy-worker.yml` из `main` затирает приватную прод-сборку (см. `CLAUDE.md`).
