import { ArrowRight, Clock3, Star } from "lucide-react";

import type {
  FavoriteRecord,
  HistoryRecord,
} from "../../../lib/storage/learning-data";
import { historyPreviewRecords } from "../history-preview";

type DictionaryHomeProps = {
  history: HistoryRecord[];
  favorites: FavoriteRecord[];
  onSelect: (entryId: string) => void;
  onOpenLibrary: (tab: "history" | "favorites") => void;
};

const HOME_COLLECTION_PREVIEW_LIMIT = 5;

type HomeCollectionProps = {
  title: string;
  emptyLabel: string;
  icon: "history" | "favorites";
  items: Array<{
    key: string;
    entryId: string;
    headword: string;
    detail?: string;
  }>;
  onOpen: () => void;
  onSelect: (entryId: string) => void;
};

function HomeCollection({
  title,
  emptyLabel,
  icon,
  items,
  onOpen,
  onSelect,
}: HomeCollectionProps) {
  return (
    <section className="home-collection">
      <header>
        <span className="home-collection-icon" aria-hidden="true">
          {icon === "history" ? <Clock3 /> : <Star />}
        </span>
        <h2>{title}</h2>
        <button type="button" title={`查看全部${title}`} aria-label={`查看全部${title}`} onClick={onOpen}>
          <ArrowRight aria-hidden="true" />
        </button>
      </header>

      {items.length ? (
        <div className="home-entry-list">
          {items.slice(0, HOME_COLLECTION_PREVIEW_LIMIT).map((item) => (
            <button key={item.key} type="button" onClick={() => onSelect(item.entryId)}>
              <strong>{item.headword}</strong>
              {item.detail ? <span>{item.detail}</span> : null}
            </button>
          ))}
        </div>
      ) : (
        <p className="home-empty">{emptyLabel}</p>
      )}
    </section>
  );
}

export function DictionaryHome({
  history,
  favorites,
  onSelect,
  onOpenLibrary,
}: DictionaryHomeProps) {
  const historyPreview = historyPreviewRecords(
    history,
    HOME_COLLECTION_PREVIEW_LIMIT,
  );

  return (
    <section className="dictionary-home" aria-label="词典首页">
      <h1 className="visually-hidden">词典首页</h1>
      <HomeCollection
        title="最近查询"
        emptyLabel="暂无查询记录"
        icon="history"
        items={historyPreview.map((record) => ({
          key: record.key,
          entryId: record.entryId,
          headword: record.headword,
          detail: record.visitCount > 1 ? `${record.visitCount} 次` : undefined,
        }))}
        onOpen={() => onOpenLibrary("history")}
        onSelect={onSelect}
      />
      <HomeCollection
        title="收藏词条"
        emptyLabel="暂无收藏词条"
        icon="favorites"
        items={favorites.map((record) => ({
          key: record.key,
          entryId: record.entryId,
          headword: record.headword,
        }))}
        onOpen={() => onOpenLibrary("favorites")}
        onSelect={onSelect}
      />
    </section>
  );
}
