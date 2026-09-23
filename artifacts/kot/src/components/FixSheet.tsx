import React, { useEffect, useRef, useState } from 'react';
import { useApp } from '@/hooks/use-app';
import { Celebrate } from '@/lib/celebrate';

const SHEET_CHIPS = {
  A: ['здесь плохо слышно, перепроверьте', 'тут не я говорю, а собеседник'],
  B: ['здесь слишком сложно — попроще', 'добавьте клинический пример', 'покороче'],
  C: ['картинка простовата — глубже', 'смените образ', 'подпись не помещается'],
  // N — «назовите»: короткое имя, без подсказок-чипов и без праздника.
  N: []
};

export function FixSheet() {
  const { sheet, closeSheet, toast } = useApp();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!sheet.isOpen) return;
    setText(sheet.initial);
    const t = setTimeout(() => {
      inputRef.current?.focus();
      // Прежний текст выделен: мелкая правка — курсором, новое — просто поверх.
      inputRef.current?.select();
    }, 150);
    return () => clearTimeout(t);
  }, [sheet.isOpen, sheet.initial]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sheet.isOpen) closeSheet();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sheet.isOpen, closeSheet]);

  const addChip = (t: string) => {
    setText(prev => prev ? prev + '. ' + t : t);
  };

  const isName = sheet.kind === 'N';

  const submitFix = () => {
    if (!text.trim()) {
      toast(isName ? 'Напишите название' : 'Напишите в двух словах, что поправить');
      return;
    }
    // Имя — одной строкой, переносы ни к чему.
    if (sheet.callback) sheet.callback(isName ? text.trim().replace(/\s+/g, ' ') : text);
    closeSheet();
    if (!isName) {
      Celebrate.burst(window.innerWidth / 2, window.innerHeight * 0.7);
      toast('Поняла — поправлю и обновлю');
    }
  };

  return (
    <div className={`overlay ${sheet.isOpen ? 'show' : ''}`} id="overlay" onClick={(e) => { if ((e.target as any).id === 'overlay') closeSheet(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
        <div className="grab"></div>
        <h3 id="sheetTitle">{sheet.title}</h3>
        {!isName && (
          <p className="s" id="sheetSub">Напишите своими словами — я переделаю. Спешить некуда.</p>
        )}

        <textarea
          id="sheetText"
          ref={inputRef}
          rows={isName ? 1 : undefined}
          placeholder={isName ? 'Название' : 'Например: здесь плохо слышно, перепроверьте это место.'}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // В режиме имени Enter отправляет, а не добавляет перенос.
            if (isName && e.key === 'Enter') {
              e.preventDefault();
              submitFix();
            }
          }}
        />
        
        <div className="ex-chips" id="sheetChips">
          {(SHEET_CHIPS[sheet.kind] || []).map(chip => (
            <span key={chip} className="echip" onClick={() => addChip(chip)}>
              {chip}
            </span>
          ))}
        </div>
        
        <div className="btnrow">
          <button className="btn" style={{ flex: 1 }} onClick={closeSheet}>Отмена</button>
          <button className="btn primary" style={{ flex: 1.4 }} onClick={submitFix}>Отправить</button>
        </div>
      </div>
    </div>
  );
}
