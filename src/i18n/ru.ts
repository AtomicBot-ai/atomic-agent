import type { MessageKey } from "./en.js";

/**
 * Russian (ATO-571). Same keys and the same `{params}` as `en.ts`, which
 * `i18n.test.ts` checks. Key names, commands, paths and product names stay
 * as they are. Lines that the layout measures (the explainer, the choice
 * details) are kept close to the English width.
 */
export const ru: Readonly<Record<MessageKey, string>> = {
  "onboarding.subtitle.choose": "настройка · шаг 1 из 2",
  "onboarding.subtitle.localPick": "локальные модели · шаг 2 из 2",
  "onboarding.subtitle.localHfRef": "локальные модели · Hugging Face",
  "onboarding.subtitle.localHfPick": "локальные модели · выбор файла",
  "onboarding.subtitle.localDownload": "локальные модели · загрузка",
  "onboarding.subtitle.proposeSecond": "и ещё кое-что",
  "onboarding.subtitle.waitOrJump": "почти готово",
  "onboarding.subtitle.importPick": "перенос данных · последний шаг",
  "onboarding.subtitle.importDone": "перенос данных · готово",
  "onboarding.subtitle.cloud": "облачная модель · шаг 2 из 2",
  "onboarding.subtitle.customChatUrl": "свой сервер · шаг 2 из 2",
  "onboarding.subtitle.customEmbeddingUrl": "свой сервер · эмбеддинги",
  "onboarding.subtitle.finished": "настраиваем…",

  "onboarding.footer.quit": "ctrl+c выйти",
  "onboarding.footer.quitArmed": "ctrl+c нажмите ещё раз, чтобы выйти",
  "onboarding.footer.choose": "↑/↓ навигация   enter выбрать   1–3 быстрый выбор   esc пропустить   {quit}",
  "onboarding.footer.listSearch": "↑/↓ навигация   / поиск   enter выбрать   esc назад   {quit}",
  "onboarding.footer.list": "↑/↓ навигация   enter выбрать   esc назад   {quit}",
  "onboarding.footer.customChatUrl": "enter проверить и продолжить   esc назад   {quit}",
  "onboarding.footer.customEmbeddingUrl": "enter проверить и сохранить   пустой enter без эмбеддингов   esc назад   {quit}",
  "onboarding.footer.hfLookupBusy": "esc отменить поиск   {quit}",
  "onboarding.footer.hfRef": "enter найти   {clear}esc назад   {quit}",
  "onboarding.footer.hfClear": "ctrl+l очистить",
  "onboarding.footer.hfPick": "↑/↓ навигация   enter скачать   esc назад   {quit}",
  "onboarding.footer.localDownload": "c пока настроить облако   s сразу к агенту   {quit}",
  "onboarding.footer.proposeSecond": "↑/↓ навигация   enter выбрать   esc пропустить   {quit}",
  "onboarding.footer.importBusy": "переносим…   {quit}",
  "onboarding.footer.importPick": "↑/↓ навигация   space отметить   enter перенести   esc пропустить   {quit}",
  "onboarding.footer.importDone": "любая клавиша, чтобы начать   {quit}",
  "onboarding.footer.waitOrJump": "↑/↓ навигация   enter начать или добавить провайдера   {quit}",

  "onboarding.intro.pressAnyKey": "[ нажмите любую клавишу ]",

  "onboarding.choose.explainer1": "atomic-agent работает с моделями тремя способами. Выбор не навсегда:",
  "onboarding.choose.explainer2": "остальные можно добавить в любой момент через меню.",
  "onboarding.choose.local.label": "Локальные модели",
  "onboarding.choose.local.detail1": "На этом компьютере. Приватно, без ключа и платы за токены.",
  "onboarding.choose.local.detail2": "Ответит через минуту, модель побольше подтянется сама.",
  "onboarding.choose.cloud.label": "Облачные модели",
  "onboarding.choose.cloud.detail1": "OpenRouter, Anthropic, Gemini, Groq и ещё 20.",
  "onboarding.choose.cloud.detail2": "Самый быстрый путь к агенту, нужен API-ключ.",
  "onboarding.choose.custom.label": "Свой сервер",
  "onboarding.choose.custom.detail1": "URL вашего OpenAI-совместимого API или llama-server.",
  "onboarding.choose.custom.detail2": "Ничего не скачиваем и больше ни о чём не спрашиваем.",
  "onboarding.choose.custom.found": "Уже запущено здесь: {servers}.",
};
