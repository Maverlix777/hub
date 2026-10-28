# Уведомления от агентов

Код поддерживает бесплатный Web Push: браузер сохраняет подписку через защищённый Worker в D1, GitHub Actions отправляет зашифрованное уведомление через `web-push`. На экране блокировки только «От агентов» и «В репозитории появились изменения. Открой Хаб.»: названия приватных репозиториев, авторы и сообщения коммитов не передаются.

Секреты этой задачей не создаются. Неполная конфигурация даёт явный `Web Push skipped: configuration is incomplete.` до сетевых запросов. Такой запуск не доказывает доставку. Ошибки реальной отправки завершают процесс с кодом 1; ответы провайдеров с URL подписок в лог не выводятся. HTTP 404/410 удаляет истёкшую подписку из D1.

## Осталось два шага

1. После закрытия блокера [#784](https://github.com/Maverlix777/agent-handoffs/issues/784) развернуть Worker с миграцией D1 и нужной конфигурацией. Владелец отдельно обеспечивает существующую пару VAPID и токен доставки: Worker получает `VAPID_PUBLIC_KEY` и секрет `PUSH_DELIVERY_TOKEN`; GitHub Actions получает secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:` контакт владельца) и тот же `PUSH_DELIVERY_TOKEN`. Закрытый VAPID-ключ остаётся только в GitHub secrets. Не запускать существующий deploy workflow поверх приватной production-сборки без согласованного пути развёртывания. В workflow зафиксирован API `https://hub.kolobovdjp.org/hub/api/push/delivery`; если согласован другой адрес Worker, изменить только этот адрес в проверенном коде.
2. На телефоне открыть хаб, войти владельцем и нажать кнопку уведомлений. На iPhone Web Push требует iOS 16.4 или новее и веб-приложение на домашнем экране ([WebKit, 2023-02-16](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), сверено 2026-10-26). Разрешить уведомления, затем выполнить тестовый push и сопоставить лог Actions с уведомлением на телефоне. Эти действия и реальная доставка в этой задаче не проверяются.

## Подключение других репозиториев

Workflow в hub срабатывает при push в любую ветку и вручную. Он сам не видит push в других репозиториях. В каждом нужном `Maverlix777/*` нужен отдельный caller, с явной передачей четырёх secrets. Пример (заменить `REVIEWED_COMMIT_SHA` на проверенный коммит hub, содержащий workflow):

```yaml
name: Notify agents
on: [push]
permissions:
  contents: read
jobs:
  notify:
    uses: Maverlix777/hub/.github/workflows/push-notifications.yml@REVIEWED_COMMIT_SHA
    secrets:
      PUSH_DELIVERY_TOKEN: ${{ secrets.PUSH_DELIVERY_TOKEN }}
      VAPID_PUBLIC_KEY: ${{ secrets.VAPID_PUBLIC_KEY }}
      VAPID_PRIVATE_KEY: ${{ secrets.VAPID_PRIVATE_KEY }}
      VAPID_SUBJECT: ${{ secrets.VAPID_SUBJECT }}
```

Для push внутри hub workflow запускает sender из точного коммита события (`github.sha`), чтобы новая ветка проверяла собственную реализацию. При вызове из другого репозитория запускается sender из main репозитория hub. Fork пропускается. Подключение caller и secrets в чужие репозитории здесь не выполняется; без них покрытие `Maverlix777/*` отсутствует.

API доставки доступен только с bearer-токеном; API браузерной подписки использует существующий вход владельца. Подписки содержат адреса доставки и ключи браузера: не публиковать их в issue, артефактах или логах.

Проверка sender офлайн: `node --test test/push-sender.test.js`. Контракт библиотеки: [web-push API](https://github.com/web-push-libs/web-push#api-reference), проверен 2026-10-26; точная установленная версия закреплена в package-lock.json.

Проверки backend и UI: node --experimental-sqlite --test test/push.test.js test/push-ui.test.js. Эти проверки не используют телефон и не доказывают реальную доставку.
