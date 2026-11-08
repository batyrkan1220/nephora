# Nephora — лидерборд менеджеров

Считается воронка «Первичный»: сделка попадает в лидерборд в момент **первого** перехода в стадию «Заказ» (`UC_IP5X36`). «Предзаказ» не считается.

## Render (Frankfurt)
`render.yaml` — Blueprint: Node web service, регион `frankfurt`, без зависимостей.

Переменные окружения (задаются в Render, **не в коде**):
- `BITRIX_WEBHOOK` — входящий вебхук Bitrix24 (права `crm`, `user`, `department`)
- `DASH_PASSWORD` — пароль для входа (логин `admin`, можно сменить через `DASH_USER`)

Сервер проксирует только чтение: `department.get`, `user.get`, `crm.stagehistory.list`, `crm.deal.list` (и `batch` из них). Вебхук в браузер не попадает.

Локально: `BITRIX_WEBHOOK=... node server.js` → http://localhost:3000
