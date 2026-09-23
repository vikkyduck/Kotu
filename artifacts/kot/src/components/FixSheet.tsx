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

  const isName = sheet.kind === 'N';

  const submitFix = () => {
    if (!text.trim()) {
      toast(isName ? 'Напишите название' : 'Напишите в двух словах, что поправить');
      return;
    }
    // Имя — одной строкой, переносы ни к чему.
    if (sheet.callback) sheet.callback(isName ? text.trim().replace(/\s+/g, ' ') : text);
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
          rows={isName ? 1 : undefined}
          placeholder={isName ? 'Название' : undefined}
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

        <div className="btnrow">
          <button className="btn" style={{ flex: 1 }} onClick={closeSheet}>Отмена</button>
          <button className="btn primary" style={{ flex: 1.4 }} onClick={submitFix}>Отправить</button>
        </div>
      </div>
    </div>
  );
}
