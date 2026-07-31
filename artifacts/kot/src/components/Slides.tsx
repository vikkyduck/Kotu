import React, { useState, useEffect } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

const SLIDES = ['Защитные механизмы','Вытеснение','Отрицание','Проекция','Проективная идентификация','Расщепление'];

export function Slides() {
  const { screen, go, toast, openSheet } = useApp();
  const [view, setView] = useState<'slForm'|'slJob'|'slResult'>('slForm');
  const [slidesState, setSlidesState] = useState(() => SLIDES.map((s, i) => ({ title: s, loading: false })));

  useEffect(() => {
    const handleResume = () => {
      setView('slResult');
    };
    window.addEventListener('resume-slides', handleResume);
    return () => window.removeEventListener('resume-slides', handleResume);
  }, []);

  useEffect(() => {
    if (screen !== 's-slides') {
      setView('slForm');
    }
  }, [screen]);

  if (screen !== 's-slides') return null;

  return (
    <section className="screen active" id="s-slides">
      <h2 className="h2">Собрать презентацию</h2>
      <p className="sub">Выберите лекцию — соберу к ней слайды с картинками в едином стиле.</p>
      <div className="wip-note"><Icon name="clock" /> Этот раздел ещё готовится. Показываю, как он будет работать — можно спокойно посмотреть.</div>

      {view === 'slForm' && (
        <div id="slForm">
          <div className="resume" style={{ marginBottom: '18px' }}>
            <div className="r sel-lec" onClick={() => toast('Лекция выбрана')}>
              <span className="ri"><Icon name="pen" /></span>
              <span className="rt"><b>Защитные механизмы</b><span>Лекция · черновик готов</span></span>
              <span className="chev sel-mark"><Icon name="check" /></span>
            </div>
            <div className="r disabled" onClick={() => toast('Сначала подготовьте лекцию')}>
              <span className="ri"><Icon name="pen" /></span>
              <span className="rt"><b>Перенос и контрперенос</b><span>Ещё не готова</span></span>
            </div>
          </div>
          <button className="btn primary big" onClick={() => setView('slJob')}>Собрать презентацию <Icon name="arrow" /></button>
        </div>
      )}

      {view === 'slJob' && (
        <div id="slJob">
          <div className="panel bigjob">
            <div className="bi"><Icon name="clock" /></div>
            <p className="pstat">Рисую слайды</p>
            <p className="preassure" style={{ marginBottom: '6px' }}>Хорошая серия слайдов с картинками собирается не быстро — это займёт время. Пришлю уведомление, когда черновик будет готов.</p>
            <p className="preassure"><b>Можно закрыть страницу.</b></p>
          </div>
          <button className="btn big" onClick={() => setView('slResult')}>Посмотреть готовые слайды <Icon name="arrow" /></button>
          <button className="btn ghost big" onClick={() => go('s-home')}>На главную</button>
        </div>
      )}

      {view === 'slResult' && (
        <div id="slResult">
          <div className="done-head">
            <span className="dh-ic"><Icon name="check" /></span>
            <div><h3>Готово — слайды собраны</h3><p>Уже сохранены. Можно листать и менять что угодно.</p></div>
          </div>
          <p className="tnote"><Icon name="info" /> Это черновик. Не нравится картинка или подпись — нажмите на слайд и скажите своими словами, что изменить. Можно менять сколько угодно.</p>
          
          <div className="sgrid" id="slides">
            {slidesState.map((slide, i) => (
              <div className="slide" key={i} onClick={() => {
                openSheet('Что изменить в этом слайде?', 'C', () => {
                  setSlidesState(s => s.map((sl, idx) => i === idx ? { ...sl, loading: false } : sl));
                });
                setSlidesState(s => s.map((sl, idx) => i === idx ? { ...sl, loading: true } : sl));
              }}>
                {/* Пластины серии: четыре архивных тона задаются классами th-p0…3 */}
                <div className={`th th-p${i % 4}`}>
                  <span className="tag-draft">черновик</span>
                  <span className="st">{slide.title}</span>
                </div>
                <div className={`cap ${slide.loading ? 'busy' : ''}`}>
                  {slide.loading ? (
                    <><Icon name="loop" /> переделываю…</>
                  ) : (
                    <><Icon name="edit" /> нажмите, чтобы изменить</>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="btnrow">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => toast('Презентация сохранена в ваших файлах')}>
              <Icon name="download" /> Сохранить презентацию
            </button>
            <button className="btn" onClick={() => go('s-home')}>Готово</button>
          </div>
        </div>
      )}
    </section>
  );
}
