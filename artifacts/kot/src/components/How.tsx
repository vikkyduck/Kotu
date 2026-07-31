import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

export function How() {
  const { screen, go } = useApp();

  if (screen !== 's-how') return null;

  return (
    <section className="screen active" id="s-how">
      <h2 className="h2">Как это работает</h2>
      <div className="panel" style={{ marginTop: '18px' }}>
        <div className="ex"><span className="ei"><Icon name="shield" /></span><div><b>Никакого ВПН и отдельных паролей</b><p>Всё работает прямо в браузере, на одном сайте. Заходите — и сразу работаете.</p></div></div>
        <div className="ex"><span className="ei"><Icon name="lock" /></span><div><b>Записи сеансов никуда не уходят</b><p>Они обрабатываются на защищённом сервере и не передаются в чужие сервисы.</p></div></div>
        <div className="ex"><span className="ei"><Icon name="eye" /></span><div><b>Имена пациентов скрываются сами</b><p>Вам не нужно за этим следить — но вы всегда можете отключить, если это ваша лекция.</p></div></div>
        <div className="ex"><span className="ei"><Icon name="loop" /></span><div><b>Вы ничего не испортите</b><p>Любой текст или слайд можно вернуть и поправить. Ошибиться здесь невозможно.</p></div></div>
        <div className="ex"><span className="ei"><Icon name="clock" /></span><div><b>Большие задачи идут в фоне</b><p>Лекции и презентации готовятся несколько часов — можно закрыть страницу, я сохраню и пришлю уведомление.</p></div></div>
        <div className="ex"><span className="ei"><Icon name="check" /></span><div><b>Ничего не нужно настраивать</b><p>Внутри — современный искусственный интеллект, но все сложности я беру на себя. Вы просто говорите, что нужно.</p></div></div>
      </div>
      <p className="soon-note">
        Пошаговые подсказки «как сделать…» появятся здесь же — скоро.
      </p>
      <button className="btn primary big" onClick={() => go('s-home')}>Понятно, спасибо</button>
    </section>
  );
}
