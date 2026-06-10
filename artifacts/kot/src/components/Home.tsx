import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

const HAS_HISTORY = true; // Hardcoded based on prototype

export function Home() {
  const { screen, go } = useApp();

  if (screen !== 's-home') return null;

  return (
    <section className="screen active" id="s-home">
      <h1 className="hello">Добрый вечер, Кот.</h1>
      <p className="lead">С чего начнём сегодня?</p>

      <div className="promise">
        <span className="pico" data-icon="shield"><Icon name="shield" /></span>
        <span className="pt"><b>Просто откройте и работайте.</b> Без ВПН и отдельных паролей, всё сохраняется само, данные остаются у вас.</span>
      </div>

      <button className="task hero" onClick={() => go('s-transcribe')}>
        <span className="ti"><span data-icon="mic"><Icon name="mic" /></span></span>
        <span className="tb"><h3>Расшифровать запись</h3><p>Аудио лекции или сеанса — превращу в готовый текст.</p></span>
        <span className="go" data-icon="arrow"><Icon name="arrow" /></span>
      </button>

      {!HAS_HISTORY && (
        <p id="startHint" className="start-hint">С чего начать — загрузите запись, остальное я сделаю сама.</p>
      )}

      <div className="soon-label">Скоро здесь появятся</div>
      <button className="task wip" onClick={() => go('s-lecture')}>
        <span className="ti"><span data-icon="pen"><Icon name="pen" /></span></span>
        <span className="tb"><span className="th-row"><h3>Подготовить лекцию</h3><span className="soon">в процессе сборки</span></span><p>Соберу материал и напишу полный текст выступления.</p></span>
        <span className="wip-cta">посмотреть, как будет</span>
      </button>
      <button className="task wip" onClick={() => go('s-slides')}>
        <span className="ti"><span data-icon="deck"><Icon name="deck" /></span></span>
        <span className="tb"><span className="th-row"><h3>Собрать презентацию</h3><span className="soon">в процессе сборки</span></span><p>Подготовлю слайды с картинками к вашей лекции.</p></span>
        <span className="wip-cta">посмотреть, как будет</span>
      </button>

      {HAS_HISTORY && (
        <div id="resumeBlock">
          <div className="label">Продолжить начатое</div>
          <div className="resume">
            {/* The prototype hardcodes state flags for the resume actions. We will pass params via local component state later if needed, but since it's a static prototype, we just set the states in the components when mounted. For now, we simulate the 'resume' call. */}
            <div className="r" onClick={() => { window.dispatchEvent(new CustomEvent('resume-transcribe')); go('s-transcribe'); }}>
              <span className="ri" data-icon="mic"><Icon name="mic" /></span>
              <span className="rt"><b>Сеанс, 4 июня</b><span>Расшифровка — черновик готов</span></span>
              <span className="chev" data-icon="chevron"><Icon name="chevron" /></span>
            </div>
            <div className="r" onClick={() => { window.dispatchEvent(new CustomEvent('resume-lecture')); go('s-lecture'); }}>
              <span className="ri" data-icon="pen"><Icon name="pen" /></span>
              <span className="rt"><b>Лекция «Защитные механизмы»</b><span>Черновик почти готов — можно читать</span></span>
              <span className="chev" data-icon="chevron"><Icon name="chevron" /></span>
            </div>
            <div className="r" onClick={() => { window.dispatchEvent(new CustomEvent('resume-slides')); go('s-slides'); }}>
              <span className="ri" data-icon="deck"><Icon name="deck" /></span>
              <span className="rt"><b>Презентация к «Защитным механизмам»</b><span>Слайды готовятся</span></span>
              <span className="chev" data-icon="chevron"><Icon name="chevron" /></span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
