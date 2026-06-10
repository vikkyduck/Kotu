import React, { useState, useEffect } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

const CHAPTERS = [
  {h:'Глава 1 · Что мы защищаем и от чего',txt:'Начнём с простого вопроса: зачем психике вообще защищаться? Вытеснение — это не забывание, а тихая, постоянная работа: психика удерживает невыносимое вне поля сознания. И всё же вытесненное не исчезает — оно возвращается в оговорках, снах, симптомах…'},
  {h:'Глава 2 · Проекция и проективная идентификация',txt:'Здесь важно не спутать два близких механизма. При проекции человек приписывает другому собственные чувства. Кляйн идёт дальше: при проективной идентификации он бессознательно вынуждает другого эти чувства пережить — и это уже разговор не об одном человеке, а о двоих…'},
  {h:'Глава 3 · Защиты, держащие самооценку',txt:'Идеализация и обесценивание ходят парой. Они оберегают хрупкое чувство собственного «я» от встречи с тем, что человек и любим, и ненавидим одновременно. В клинике это видно особенно ясно…'},
];

export function Lecture() {
  const { screen, go, toast, openSheet } = useApp();
  const [view, setView] = useState<'lecForm'|'lecJob'|'lecResult'>('lecForm');
  const [topic, setTopic] = useState('');
  const [hours, setHours] = useState('5–6 часов');

  useEffect(() => {
    const handleResume = () => {
      setView('lecResult');
    };
    window.addEventListener('resume-lecture', handleResume);
    return () => window.removeEventListener('resume-lecture', handleResume);
  }, []);

  useEffect(() => {
    if (screen !== 's-lecture') {
      setView('lecForm');
    }
  }, [screen]);

  const startLecture = () => {
    if (!topic.trim()) {
      toast('Расскажите в двух словах, о чём лекция');
      return;
    }
    setView('lecJob');
  };

  if (screen !== 's-lecture') return null;

  return (
    <section className="screen active" id="s-lecture">
      <h2 className="h2">Подготовить лекцию</h2>
      <p className="sub">Расскажите своими словами, о чём лекция — остальное я возьму на себя.</p>
      <div className="wip-note"><Icon name="clock" /> Этот раздел ещё готовится. Показываю, как он будет работать — можно спокойно посмотреть.</div>

      {view === 'lecForm' && (
        <div id="lecForm">
          <div className="panel">
            <div className="fieldlbl">О чём будет лекция?</div>
            <textarea 
              className="topic" 
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder="Например: защитные механизмы личности — для студентов второго курса. Хочу начать с Фрейда и дойти до современных взглядов, с клиническими примерами."
            />

            <div className="fieldlbl">Примерно на сколько часов?</div>
            <div className="pills">
              {['1 час', '2–3 часа', '5–6 часов'].map(h => (
                <span key={h} className={`pill-opt ${hours === h ? 'on' : ''}`} onClick={() => setHours(h)}>{h}</span>
              ))}
            </div>

            <div className="fieldlbl">Опереться на ваши книги? <span style={{ fontWeight: 400, color: 'var(--muted)' }}>— по желанию</span></div>
            <div className="filecard" style={{ cursor: 'pointer' }} onClick={() => toast('Здесь можно будет загрузить книги')}>
              <span className="fi"><Icon name="book" /></span>
              <div><b>Загрузить книги</b><span>Если не нужно — просто пропустите</span></div>
              <span className="chev" style={{ marginLeft: 'auto', color: 'var(--muted)' }}><Icon name="chevron" /></span>
            </div>
          </div>
          <button className="btn primary big" onClick={startLecture}>Начать готовить лекцию <Icon name="arrow" /></button>
        </div>
      )}

      {view === 'lecJob' && (
        <div id="lecJob">
          <div className="panel bigjob">
            <div className="bi"><Icon name="clock" /></div>
            <p className="pstat" style={{ fontFamily: 'var(--serif)', fontSize: '19px', fontWeight: 600, margin: '0 0 8px' }}>Принялась за работу</p>
            <p className="preassure" style={{ marginBottom: '6px' }}>Полный текст лекции — это большая работа, на несколько часов. Я соберу хороший черновик и пришлю уведомление, когда он будет готов.</p>
            <p className="preassure"><b>Можно закрыть страницу и спокойно отдыхать.</b></p>
          </div>
          <button className="btn big" onClick={() => setView('lecResult')}>Посмотреть, как будет выглядеть черновик <Icon name="arrow" /></button>
          <button className="btn ghost big" onClick={() => go('s-home')}>На главную</button>
        </div>
      )}

      {view === 'lecResult' && (
        <div id="lecResult">
          <div className="done-head">
            <span className="dh-ic"><Icon name="check" /></span>
            <div><h3>Готово — черновик лекции собран</h3><p>Уже сохранён. Читайте как свой текст.</p></div>
          </div>
          <p className="tnote"><Icon name="info" /> Это черновик-основа. Читайте как ваш собственный текст — а если где-то не так, нажмите «поправить» и скажите своими словами. Вы ничего не испортите.</p>
          
          <div className="panel" id="chapters">
            {CHAPTERS.map((c, i) => (
              <div className="chap" key={i}>
                <h4>{c.h}</h4>
                <p id={`chap-txt-${i}`}>{c.txt}</p>
                <button className="fix" style={{ opacity: 1, display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', fontFamily: 'inherit', padding: 0 }}
                  onClick={() => {
                    const el = document.getElementById(`chap-txt-${i}`);
                    if (el) el.style.opacity = '0.55';
                    openSheet('Что поправить в этой главе?', 'B', () => {
                      if (el) el.style.opacity = '1';
                    });
                  }}
                >
                  <Icon name="edit" /> поправить своими словами
                </button>
              </div>
            ))}
          </div>

          <div className="btnrow">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => toast('Лекция сохранена в ваших файлах')}>
              <Icon name="download" /> Сохранить лекцию
            </button>
            <button className="btn" onClick={() => go('s-home')}>Готово</button>
          </div>
        </div>
      )}
    </section>
  );
}
