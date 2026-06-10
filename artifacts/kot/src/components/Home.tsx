import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import {
  useListTranscriptions,
  useDeleteTranscription,
  getListTranscriptionsQueryKey,
  type Transcription,
} from '@workspace/api-client-react';

function formatDate(value: string | Date): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export function Home() {
  const { screen, go, openTranscription, newTranscription, toast } = useApp();
  const { data: transcriptions } = useListTranscriptions();
  const queryClient = useQueryClient();
  const deleteTranscription = useDeleteTranscription();

  const history = transcriptions ?? [];
  const hasHistory = history.length > 0;

  const handleDelete = (e: React.MouseEvent, t: Transcription) => {
    e.stopPropagation();
    const ok = window.confirm(
      `Удалить «${t.title}»? Расшифровку нельзя будет вернуть.`,
    );
    if (!ok) return;
    deleteTranscription.mutate(
      { id: t.id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });
          toast('Расшифровка удалена');
        },
        onError: () => toast('Не удалось удалить. Попробуйте ещё раз.'),
      },
    );
  };

  if (screen !== 's-home') return null;

  return (
    <section className="screen active" id="s-home">
      <h1 className="hello">Добрый вечер, Кот.</h1>
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
              return (
                <div className="r" key={t.id} onClick={() => openTranscription(t.id)}>
                  <span className="ri" data-icon="mic"><Icon name="mic" /></span>
                  <span className="rt"><b>{t.title}</b><span>{subtitle}</span></span>
                  <button
                    className="rdel"
                    type="button"
                    aria-label="Удалить расшифровку"
                    title="Удалить"
                    disabled={deleteTranscription.isPending}
                    onClick={(e) => handleDelete(e, t)}
                  >
                    <Icon name="trash" />
                  </button>
                  <span className="chev" data-icon="chevron"><Icon name="chevron" /></span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
