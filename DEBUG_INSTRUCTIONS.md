# ОТЛАДКА: Как проверить передачу EVPASSPORT_ID

## Быстрый тест

### 1️⃣ Откройте URL с параметром
```
https://interpain-b24forms.vercel.app/event-register/?EVPASSPORT_ID=845
```

### 2️⃣ Нажмите F12 для открытия DevTools
- Выберите вкладку **Console** (Консоль)

### 3️⃣ Заполните Форму Шага 1
- Фамилия: Тест
- Имя: Иван  
- Телефон: +79991234567
- E-mail: test@example.com

### 4️⃣ Нажмите кнопку "Далее"

### 5️⃣ Смотрите логи в консоли!

## Что ДОЛ ЖНО быть в логах

Если всё работает, вы должны увидеть:

```
🚀 loadB24 invoked
📥 Appended Bitrix loader via proxy
...
📝 Found form element, attaching submit listener
🔴 FORM SUBMIT EVENT - Form is being submitted!
📋 Submitted fields (10):
  lastname: "Тест"
  name: "Иван"
  phone: "+7 (999) 123-45-67"
  email: "test@example.com"
  ...

📤 POST Request to: https://crmform.bitrix24.ru/...
🎯 Intercepted Bitrix fetch POST: https://...
📋 Before append - FormData entries:
  lastname: "Тест"
  name: "Иван"
  ...
✅ Added params to FormData
📋 After append - FormData entries:
  lastname: "Тест"
  name: "Иван"
  EVPASSPORT_ID: "845"
  EVENT_NAME: "Конференция InterPain 2026"
  EVENT_DATE: "2026-09-15"
  EVENT_CITY: "Москва"
```

## Интерпретация логов

| Лог | Значение |
|-----|---------|
| 🚀 | Форма начала загружаться |
| 📥 | Bitrix скрипт успешно загрузился |
| ✅ | **ПАРАМЕТРЫ ДОБАВЛЕНЫ В ОТПРАВКУ** ← ВЭ ТО НАМ НУЖНО! |
| ❌ | Произошла ошибка |
| 🔴 | Форма отправляется (начало отправки) |

## Если параметры НЕ добавляются

Если вы видите ошибку вместо `✅ Added params`:
1. Проверьте, что перехватчик срабатывает (ищите 🎯 Intercepted)
2. Посмотрите на ошибку в красном тексте (❌)
3. Скопируйте весь лог консоли и поделитесь

## Если EVPASSPORT_ID всё ещё 0 в Bitrix

Это может означать:
1. **Параметр добавляется, но Bitrix его игнорирует**
   → Нужна настройка на стороне Bitrix CRM

2. **Параметр не добавляется**
   → Перехватчик не срабатывает, нужен другой способ

3. **Параметр отправляется в неправильном поле**
   → Нужна карта соответствия полей в Bitrix
