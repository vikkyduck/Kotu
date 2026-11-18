// Тема до загрузки приложения, чтобы не мигало. По умолчанию - бумага;
// тёмная только по сохранённому выбору. Приложение тему отсюда читает.
// Отдельным файлом, а не встроенным <script>: политика безопасности сайта
// (ops/services/nginx/psy3107, Content-Security-Policy) запрещает встроенные скрипты.
(function () {
  var t = null;
  try { t = localStorage.getItem('kot-theme'); } catch (e) {}
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
})();
