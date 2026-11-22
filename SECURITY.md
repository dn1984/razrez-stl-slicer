# Security / Безопасность

## English

Razrez is a local-first, offline STL slicer. The application performs geometry
processing in the browser and does not upload models or telemetry.

Please do not open issues containing private STL files, access tokens, private
keys, passwords, or personal data. For a vulnerability report, use GitHub's
private security advisory workflow when available, or contact the maintainer
through the GitHub profile.

Supported security baseline:

- no embedded credentials or tokens;
- no external runtime network requests;
- local WebAssembly geometry processing;
- user-provided STL files are ignored by Git;
- generated build output and test screenshots are ignored by Git.

## Русский

Razrez — локальный офлайн-слайсер STL. Геометрия обрабатывается в браузере;
модели и телеметрия никуда не загружаются.

Не публикуйте в issues личные STL-файлы, токены доступа, приватные ключи,
пароли и персональные данные. Для сообщения об уязвимости используйте
приватный security advisory GitHub или свяжитесь с сопровождающим через
профиль GitHub.

Базовые меры безопасности:

- в коде нет встроенных паролей и токенов;
- приложение не делает внешних сетевых запросов во время работы;
- геометрия обрабатывается локально в WebAssembly;
- пользовательские STL исключены из Git;
- собранный dist и тестовые снимки исключены из Git.
