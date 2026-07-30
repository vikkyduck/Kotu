import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import {
  useListTranscriptions,
  useDeleteTranscription,
  getListTranscriptionsQueryKey,
  getGetTranscriptionQueryKey,
} from '@workspace/api-client-react';

function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Доброе утро, Кот.';
  if (hour >= 12 && hour < 18) return 'Добрый день, Кот.';
  if (hour >= 18 && hour < 23) return 'Добрый вечер, Кот.';
  return 'Доброй ночи, Кот.';
}

export function Home() {
  const { screen, go, toast, openTranscription, newTranscription } = useApp();
  const { data: transcriptions } = useListTranscriptions();
  const queryClient = useQueryClient();
  const deleteTranscription = useDeleteTranscription();

  const [confirmId, setConfirmId] = useState<number | null>(null);

  const history = transcriptions ?? [];
  const hasHistory = history.length > 0;

  const handleDelete = (id: number) => {
    deleteTranscription.mutate(
      { id },
      {
        onSuccess: () => {
          setConfirmId(null);
          queryClient.removeQueries({ queryKey: getGetTranscriptionQueryKey(id) });
          queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
          toast('Запись удалена');
        },
        onError: () => {
          toast('Не удалось удалить — попробуйте ещё раз');
        },
      },
    );
  };

  if (screen !== 's-home') return null;

  return (
    <section className="screen active" id="s-home">
      <h1 className="hello">{greeting()}</h1>
      <p className="lead">С чего начнём сегодня?</p>

      <div className="promise">
        <span className="pico" data-icon="shield"><Icon name="shield" /></span>
        <span className="pt"><b>Просто откройте и работайте.</b> Без ВПН и отдельных паролей, всё сохраняется само, данные остаются у вас.</span>
      </div>

      <button className="task hero" onClick={() => newTranscription()}>
        <span className="ti"><span data-icon="mic"><Icon name="mic" /></span></span>
        <span className="tb"><h3>Расшифровать запись</h3><p>Аудио лекции или сеанса — превращу в готовый текст.</p></span>
        <span className="go" data-icon="arrow"><Icon name="arrow" /></span>
      </button>

      {!hasHistory && (
        <p id="startHint" className="start-hint">С чего начать — загрузите запись, остальное я сделаю сама.</p>
      )}

      <button className="task hero" onClick={() => go('s-library')}>
        <span className="ti"><span data-icon="book"><Icon name="book" /></span></span>
        <span className="tb"><h3>Библиотека</h3><p>Книги и статьи, на которые буду опираться в лекциях.</p></span>
        <span className="go" data-icon="arrow"><Icon name="arrow" /></span>
      </button>

      <button className="task hero" onClick={() => go('s-lecture')}>
        <span className="ti"><span data-icon="pen"><Icon name="pen" /></span></span>
        <span className="tb"><h3>Подготовить лекцию</h3><p>Соберу материал из библиотеки и напишу полный текст выступления.</p></span>
        <span className="go" data-icon="arrow"><Icon name="arrow" /></span>
      </button>

      <div className="soon-label">Скоро здесь появятся</div>
      <button className="task wip" onClick={() => go('s-slides')}>
        <span className="ti"><span data-icon="deck"><Icon name="deck" /></span></span>
        <span className="tb"><span className="th-row"><h3>Собрать презентацию</h3><span className="soon">в процессе сборки</span></span><p>Подготовлю слайды с картинками к вашей лекции.</p></span>
        <span className="wip-cta">посмотреть, как будет</span>
      </button>

      {hasHistory && (
        <div id="resumeBlock">
          <div className="label">Продолжить начатое</div>
          <div className="resume">
            {history.map((t) => {
              const subtitle =
                t.status === 'processing'
                  ? 'Расшифровываю…'
                  : t.status === 'error'
                    ? 'Не удалось — откройте, чтобы повторить'
                    : `Расшифровка · ${formatDate(t.createdAt)}`;
              const isConfirming = confirmId === t.id;
              const isDeleting = deleteTranscription.isPending && isConfirming;
              return (
                <div
                  className={`r ${isConfirming ? 'confirming' : ''}`}
                  key={t.id}
                  onClick={() => { if (!isConfirming) openTranscription(t.id); }}
                >
                  <span className="ri" data-icon="mic"><Icon name="mic" /></span>
                  <span className="rt"><b>{t.title}</b><span>{subtitle}</span></span>
                  {isConfirming ? (
                    <span className="rconfirm" onClick={(e) => e.stopPropagation()}>
                      <span className="rconfirm-q">Удалить?</span>
                      <button
                        className="rconfirm-yes"
                        disabled={isDeleting}
                        onClick={() => handleDelete(t.id)}
                      >
                        {isDeleting ? 'Удаляю…' : 'Удалить'}
                      </button>
                      <button
                        className="rconfirm-no"
                        disabled={isDeleting}
                        onClick={() => setConfirmId(null)}
                      >
                        Отмена
                      </button>
                    </span>
                  ) : (
                    <>
                      <button
                        className="rdel"
                        aria-label="Удалить запись"
                        title="Удалить запись"
                        onClick={(e) => { e.stopPropagation(); setConfirmId(t.id); }}
                      >
                        <Icon name="trash" />
                      </button>
                      <span className="chev" data-icon="chevron"><Icon name="chevron" /></span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
