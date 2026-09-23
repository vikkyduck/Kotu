import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/hooks/use-app';

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

  const submitFix = () => {
    if (!text.trim()) {
      toast('Напишите название');
      return;
    }
    // Имя — одной строкой, переносы ни к чему.
    if (sheet.callback) sheet.callback(text.trim().replace(/\s+/g, ' '));
    // Итог сообщает тот, кто открыл окно: отсюда ответа сервера не видно.
    closeSheet();
  };

  return (
    <div className={`overlay ${sheet.isOpen ? 'show' : ''}`} id="overlay" onClick={(e) => { if ((e.target as any).id === 'overlay') closeSheet(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
        <div className="grab"></div>
        <h3 id="sheetTitle">{sheet.title}</h3>

        <textarea
          id="sheetText"
          ref={inputRef}
          rows={1}
          placeholder="Название"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            // Enter сохраняет, а не добавляет перенос: это имя, не текст.
            if (e.key === 'Enter') {
              e.preventDefault();
              submitFix();
            }
          }}
        />

        <div className="btnrow">
          <button className="btn" style={{ flex: 1 }} onClick={closeSheet}>Отмена</button>
          <button className="btn primary" style={{ flex: 1.4 }} onClick={submitFix}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}
