import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { Celebrate } from '@/lib/celebrate';

const DIALOG = [
  {who:'Вы',tc:'00:12',b:false,txt:'Итак, на прошлой встрече мы остановились на том, что эта тревога возникает каждый раз перед…'},
  {who:'Собеседник',tc:'00:21',b:true,txt:'…да, перед тем как я захожу к §.',name:'доктору Лебедеву'},
  {who:'Вы',tc:'00:29',b:false,txt:'И вы сказали, что это похоже на ощущение из детства. Можете вернуться туда?'},
  {who:'Собеседник',tc:'00:41',b:true,txt:'Это было в §, мне было лет семь. Эээ… отец тогда…',name:'другом городе'},
  {who:'Вы',tc:'00:55',b:false,txt:'Не торопитесь. Мы можем остановиться здесь столько, сколько нужно.'},
  {who:'Собеседник',tc:'01:08',b:true,txt:'(пауза) …я не уверен, что хочу об этом говорить прямо сейчас.'},
];

export function Transcribe() {
  const { screen, go, toast, openSheet } = useApp();
  const [view, setView] = useState<'tcUpload'|'tcReady'|'tcProc'|'tcResult'>('tcUpload');
  const [step, setStep] = useState({ n: 0, allDone: false, loading: false });
  const [sub, setSub] = useState<string | null>('Загрузите аудио — я переведу его в текст. Это займёт пару минут.');
  
  const [opts, setOpts] = useState({ names: 'on', spk: 'on' });
  const [optsOpen, setOptsOpen] = useState({ names: false, spk: false });
  const [procStat, setProcStat] = useState('Слушаю запись…');
  const [procProgress, setProcProgress] = useState(6);
  
  const [linesState, setLinesState] = useState(() => DIALOG.map((l, i) => ({ ...l, shown: false, id: i })));

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const schedule = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  };

  useEffect(() => () => clearTimers(), []);

  useEffect(() => {
    const handleResume = () => {
      clearTimers();
      setView('tcResult');
      setStep({ n: 2, allDone: true, loading: false });
      setSub(null);
    };
    window.addEventListener('resume-transcribe', handleResume);
    return () => window.removeEventListener('resume-transcribe', handleResume);
  }, []);

  useEffect(() => {
    if (screen !== 's-transcribe') {
      // Reset when navigating away — cancel any in-flight simulated work
      clearTimers();
      setView('tcUpload');
      setStep({ n: 0, allDone: false, loading: false });
      setSub('Загрузите аудио — я переведу его в текст. Это займёт пару минут.');
    }
  }, [screen]);

  const reset = () => {
    setView('tcUpload');
    setStep({ n: 0, allDone: false, loading: false });
    setSub('Загрузите аудио — я переведу его в текст. Это займёт пару минут.');
  };

  const pickFile = () => {
    setView('tcReady');
    setStep({ n: 1, allDone: false, loading: false });
    setSub('Всё настроено бережно. Проверьте — и начнём.');
  };

  const getProcSteps = () => {
    const s = ['Слушаю запись…', 'Записываю текст…'];
    if (opts.spk === 'on') s.push('Различаю, кто говорит…');
    if (opts.names === 'on') s.push('Скрываю имена пациентов…');
    s.push('Навожу порядок…');
    return s;
  };

  const runTranscribe = () => {
    setView('tcProc');
    setStep({ n: 2, allDone: false, loading: true });
    setSub('Идёт работа — можно не ждать у экрана.');
    
    const steps = getProcSteps();
    let i = 0;
    setProcProgress(6);
    setProcStat(steps[0]);

    const tick = () => {
      i++;
      setProcProgress(Math.round((i / steps.length) * 100));
      if (i < steps.length) {
        setProcStat(steps[i]);
        schedule(tick, 820);
      } else {
        setProcStat('Готово');
        schedule(() => {
          setView('tcResult');
          setStep({ n: 2, allDone: true, loading: false });
          setSub(null);
          
          const resultHead = document.querySelector('#tcResult .done-head');
          if (resultHead) {
            const r = resultHead.getBoundingClientRect();
            Celebrate.success(window.innerWidth / 2, Math.max(150, r.top + 30));
          }
        }, 550);
      }
    };
    schedule(tick, 820);
  };

  const toggleLineName = (id: number) => {
    setLinesState(s => s.map(l => l.id === id ? { ...l, shown: !l.shown } : l));
  };

  if (screen !== 's-transcribe') return null;

  return (
    <section className="screen active" id="s-transcribe">
      <h2 className="h2">Расшифровать запись</h2>
      {sub && <p className="sub" id="tcSub">{sub}</p>}

      <div className="stepper" id="tcSteps">
        {[
          { lbl: 'Запись' },
          { lbl: 'Проверка' },
          { lbl: 'Готово' }
        ].map((s, i) => {
          const done = step.allDone || i < step.n;
          const active = step.allDone ? i === 2 : i === step.n;
          const loading = active && step.loading;
          
          return (
            <React.Fragment key={i}>
              <div className={`step ${done ? 'done' : ''} ${active ? 'active' : ''} ${loading ? 'loading' : ''}`}>
                <span className="sdot">{done ? <Icon name="check" /> : (i + 1)}</span>
                <span className="slbl">{s.lbl}</span>
              </div>
              {i < 2 && <div className={`sline ${step.allDone || i < step.n ? 'fill' : ''}`}></div>}
            </React.Fragment>
          );
        })}
      </div>

      {view === 'tcUpload' && (
        <div id="tcUpload">
          <div className="drop" id="dropZone" onClick={pickFile}>
            <div className="dz"><Icon name="upload" /></div>
            <b>Перетащите запись сюда</b>
            <div className="hint">или нажмите, чтобы выбрать файл · запись остаётся у вас</div>
          </div>
        </div>
      )}

      {view === 'tcReady' && (
        <div id="tcReady">
          <div className="filecard" style={{ marginBottom: '16px' }}>
            <span className="fi"><Icon name="headphones" /></span>
            <div><b>Сеанс_4-июня.m4a</b><span>48 минут</span></div>
            <button className="chg" onClick={reset}>заменить</button>
          </div>

          <div className="panel">
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Я позабочусь об этом сама:</div>
            
            <div className="setrow">
              <span className={`si ${opts.names === 'off' ? 'off' : ''}`} id="iconNames">
                <Icon name="check" />
              </span>
              <div className="st">
                <p id="txtNames" dangerouslySetInnerHTML={{ __html: opts.names === 'on' ? 'Скрою имена и города пациентов — в тексте будет «<b>имя скрыто</b>».' : 'Оставлю текст как есть — имена скрывать не буду.' }} />
                <button className="chg" onClick={() => setOptsOpen(s => ({ ...s, names: !s.names }))}>
                  {opts.names === 'on' ? 'это моя лекция, скрывать не нужно' : 'скрыть имена'}
                </button>
                <div className={`opts ${optsOpen.names ? 'open' : ''}`} id="optNames">
                  <div className={`opt ${opts.names === 'on' ? 'sel' : ''}`} onClick={() => setOpts(s => ({...s, names: 'on'}))}>
                    <span className="rd"></span><div>Это сеанс с пациентом — скрыть имена <small>рекомендую для записей сеансов</small></div>
                  </div>
                  <div className={`opt ${opts.names === 'off' ? 'sel' : ''}`} onClick={() => setOpts(s => ({...s, names: 'off'}))}>
                    <span className="rd"></span><div>Это моя лекция — скрывать ничего не нужно</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="setrow">
              <span className={`si ${opts.spk === 'off' ? 'off' : ''}`} id="iconSpk">
                <Icon name="check" />
              </span>
              <div className="st">
                <p id="txtSpk">{opts.spk === 'on' ? 'Помечу, где говорите вы, а где собеседник.' : 'Не буду помечать говорящих — просто сплошной текст.'}</p>
                <button className="chg" onClick={() => setOptsOpen(s => ({ ...s, spk: !s.spk }))}>
                  {opts.spk === 'on' ? 'не нужно помечать' : 'пометить говорящих'}
                </button>
                <div className={`opts ${optsOpen.spk ? 'open' : ''}`} id="optSpk">
                  <div className={`opt ${opts.spk === 'on' ? 'sel' : ''}`} onClick={() => setOpts(s => ({...s, spk: 'on'}))}>
                    <span className="rd"></span><div>Пометить, кто говорит</div>
                  </div>
                  <div className={`opt ${opts.spk === 'off' ? 'sel' : ''}`} onClick={() => setOpts(s => ({...s, spk: 'off'}))}>
                    <span className="rd"></span><div>Не нужно — это просто запись лекции</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button className="btn primary big" onClick={runTranscribe}>Расшифровать запись <Icon name="arrow" /></button>
          <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--muted)', margin: '12px 0 0' }}>
            Можно закрыть страницу — я сохраню результат, он будет ждать вас здесь.
          </p>
        </div>
      )}

      {view === 'tcProc' && (
        <div id="tcProc">
          <div className="panel proc">
            <div className="orb"><span className="core"></span></div>
            <p className="pstat" id="procStat">{procStat}</p>
            <div className="pbar"><i id="procBar" style={{ width: `${procProgress}%` }}></i></div>
            <p className="preassure">Можно спокойно закрыть страницу или налить чаю — я сохраню готовый текст, и он будет ждать вас здесь.</p>
          </div>
        </div>
      )}

      {view === 'tcResult' && (
        <div id="tcResult">
          <div className="done-head">
            <span className="dh-ic"><Icon name="check" /></span>
            <div><h3>Готово — вот ваша расшифровка</h3><p>Уже сохранена. Можно спокойно читать и править.</p></div>
          </div>
          <p className="tnote"><Icon name="info" /> Если слово распознано неверно — просто исправьте его прямо в тексте, как в обычном документе. Всё сохраняется само.</p>
          
          <div className="panel" id="transcript">
            {linesState.map((l) => {
              const renderTxt = () => {
                if (!l.name) return l.txt;
                if (opts.names === 'on') {
                  const parts = l.txt.split('§');
                  return (
                    <React.Fragment>
                      {parts[0]}
                      <span 
                        className={`hidden-name ${l.shown ? 'shown' : ''}`} 
                        title="нажмите, чтобы увидеть — виден только вам"
                        onClick={() => toggleLineName(l.id)}
                        contentEditable={false}
                      >
                        {l.shown ? `${l.name} · виден только вам` : 'имя скрыто'}
                      </span>
                      {parts[1]}
                    </React.Fragment>
                  );
                } else {
                  return l.txt.replace('§', l.name);
                }
              };

              return (
                <div className="tline" key={l.id}>
                  {opts.spk === 'on' && (
                    <div className={`who ${l.b ? 'b' : ''}`}>{l.who}<span className="tc">{l.tc}</span></div>
                  )}
                  <div className="txt" contentEditable={true} spellCheck={false}>
                    {renderTxt()}
                  </div>
                  <button className="fix" onClick={(e) => {
                    const el = (e.currentTarget.parentElement?.querySelector('.txt') as HTMLElement);
                    if (el) el.style.opacity = '0.55';
                    openSheet('Что поправить в этом фрагменте?', 'A', () => {
                      if (el) el.style.opacity = '1';
                    });
                  }}>
                    <Icon name="edit" /> что-то не так?
                  </button>
                </div>
              );
            })}
          </div>
          
          <div className="btnrow">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => toast('Текст сохранён в ваших файлах')}>
              <Icon name="download" /> Сохранить текст
            </button>
            <button className="btn" onClick={() => go('s-home')}>Готово</button>
          </div>
        </div>
      )}
    </section>
  );
}
