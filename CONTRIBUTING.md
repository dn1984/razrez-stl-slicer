# Contributing / Участие в проекте

## English

1. Create a focused branch for your change.
2. Keep geometry changes covered by unit tests.
3. Run `npm run build`, `npm test`, and `npm run test:e2e` before opening a PR.
4. Do not commit STL/3MF/OBJ models, generated output, screenshots, local logs,
   credentials, or IDE files.
5. Describe user-visible behavior and the verification performed.

The project is intentionally offline-first: avoid adding runtime CDNs,
analytics, remote fonts, or network-dependent code.

## Русский

1. Создайте отдельную ветку для изменения.
2. Изменения геометрии сопровождайте юнит-тестами.
3. Перед PR запустите `npm run build`, `npm test` и `npm run test:e2e`.
4. Не добавляйте STL/3MF/OBJ-модели, сборочные файлы, снимки, логи,
   секреты и файлы IDE.
5. Опишите пользовательское поведение и выполненные проверки.

Проект намеренно работает офлайн: не добавляйте CDN, аналитику, удалённые
шрифты и код, зависящий от сети во время работы приложения.
