"use client";

import { CheckSquare, Clock3, FileText, ListChecks, Square, Star, StarOff, Trash2, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  FavoriteRecord,
  HistoryRecord,
  NoteRecord,
} from "../../../lib/storage/learning-data";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { librarySelectionReducer } from "../library-selection";
import { ConfirmDialog } from "./ConfirmDialog";

export type LibraryTab = "history" | "favorites" | "notes";

type WorkspaceDrawerProps =
  | {
      open: false;
      onClose: () => void;
    }
  | {
      open: true;
      mode: "note";
      headword: string;
      note: string;
      onNoteChange: (value: string) => void;
      onSaveNote: () => void;
      onClose: () => void;
    }
  | {
      open: true;
      mode: "library";
      tab: LibraryTab;
      history: HistoryRecord[];
      favorites: FavoriteRecord[];
      notes: NoteRecord[];
      onTabChange: (tab: LibraryTab) => void;
      onSelect: (entryId: string) => void;
      onBulkAction: (tab: LibraryTab, keys: string[]) => Promise<void>;
      onClose: () => void;
    };

type BulkActionPresentation = {
  action: string;
  confirmLabel: string;
  icon: LucideIcon;
  confirmationDescription: (count: number) => string;
};

const bulkActionPresentation: Record<LibraryTab, BulkActionPresentation> = {
  history: {
    action: "删除浏览记录",
    confirmLabel: "删除",
    icon: Trash2,
    confirmationDescription: (count) => `确定删除 ${count} 条浏览记录？`,
  },
  favorites: {
    action: "取消收藏",
    confirmLabel: "取消收藏",
    icon: StarOff,
    confirmationDescription: (count) => `确定取消收藏 ${count} 个词条？`,
  },
  notes: {
    action: "删除笔记",
    confirmLabel: "删除",
    icon: Trash2,
    confirmationDescription: (count) => `确定删除 ${count} 条笔记？`,
  },
};

type LibraryDrawerProps = Extract<WorkspaceDrawerProps, { mode: "library" }>;

function LibraryPanel(props: LibraryDrawerProps) {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [confirmingKeys, setConfirmingKeys] = useState<string[] | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const libraryRecords = props.tab === "history"
    ? props.history
    : props.tab === "favorites"
      ? props.favorites
      : props.notes;
  const bulkPresentation = bulkActionPresentation[props.tab];

  const toggleRecord = (key: string, entryId: string) => {
    if (!isSelecting) {
      props.onSelect(entryId);
      return;
    }
    setSelectedKeys((current) => librarySelectionReducer(current, { type: "toggle", key }));
  };

  const submitBulkAction = async () => {
    if (!confirmingKeys?.length || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await props.onBulkAction(props.tab, confirmingKeys);
      setSelectedKeys(new Set());
      setConfirmingKeys(null);
    } catch {
      setSubmitError("操作未完成，请重试。");
    } finally {
      setIsSubmitting(false);
    }
  };
  const BulkActionIcon = bulkPresentation.icon;

  return (
    <div className="library-panel">
      <div className="library-tabs" role="tablist" aria-label="个人词库分类">
        <button
          className={props.tab === "history" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={props.tab === "history"}
          onClick={() => props.onTabChange("history")}
        >
          <Clock3 />
          浏览
        </button>
        <button
          className={props.tab === "favorites" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={props.tab === "favorites"}
          onClick={() => props.onTabChange("favorites")}
        >
          <Star />
          收藏
        </button>
        <button
          className={props.tab === "notes" ? "is-active" : ""}
          type="button"
          role="tab"
          aria-selected={props.tab === "notes"}
          onClick={() => props.onTabChange("notes")}
        >
          <FileText />
          笔记
        </button>
      </div>

      <div className="library-selection-bar">
        {isSelecting ? (
          <>
            <span role="status">已选择 {selectedKeys.size} 项</span>
            <div role="toolbar" aria-label="批量选择">
              <button type="button" title="全选" aria-label="全选" onClick={() => {
                setSelectedKeys(librarySelectionReducer(selectedKeys, {
                  type: "select-all",
                  keys: libraryRecords.map((record) => record.key),
                }));
              }}>
                <CheckSquare aria-hidden="true" />
              </button>
              <button type="button" title="取消全选" aria-label="取消全选" onClick={() => {
                setSelectedKeys(librarySelectionReducer(selectedKeys, { type: "clear" }));
              }}>
                <Square aria-hidden="true" />
              </button>
              <button type="button" title="退出选择" aria-label="退出选择" onClick={() => {
                setIsSelecting(false);
                setSelectedKeys(new Set());
              }}>
                <X aria-hidden="true" />
              </button>
              <button
                className="is-danger"
                type="button"
                disabled={selectedKeys.size === 0}
                title={bulkPresentation.action}
                aria-label={bulkPresentation.action}
                onClick={() => {
                  setConfirmingKeys([...selectedKeys]);
                  setSubmitError(null);
                }}
              >
                <BulkActionIcon aria-hidden="true" />
              </button>
            </div>
          </>
        ) : (
          <button type="button" title="选择" aria-label="选择" onClick={() => setIsSelecting(true)}>
            <ListChecks aria-hidden="true" />
            <span>选择</span>
          </button>
        )}
      </div>

      <div className={`library-list${isSelecting ? " is-selecting" : ""}`} role="tabpanel">
        {libraryRecords.map((record) => {
          const summary = "visitedAt" in record
            ? new Date(record.visitedAt).toLocaleDateString("zh-CN")
            : "createdAt" in record
              ? new Date(record.createdAt).toLocaleDateString("zh-CN")
              : record.text;
          const isSelected = selectedKeys.has(record.key);
          return (
            <button
              className={isSelected ? "is-selected" : ""}
              type="button"
              key={record.key}
              aria-pressed={isSelecting ? isSelected : undefined}
              onClick={() => toggleRecord(record.key, record.entryId)}
            >
              {isSelecting ? (
                <span className="library-selection-indicator" aria-hidden="true">
                  {isSelected ? <CheckSquare /> : <Square />}
                </span>
              ) : null}
              <strong>{record.headword}</strong>
              <span className="library-record-summary">{summary}</span>
            </button>
          );
        })}

        {libraryRecords.length === 0 ? <p className="library-empty">暂无内容</p> : null}
      </div>
      <ConfirmDialog
        open={Boolean(confirmingKeys)}
        title={bulkPresentation.action}
        description={bulkPresentation.confirmationDescription(confirmingKeys?.length ?? 0)}
        confirmLabel={bulkPresentation.confirmLabel}
        pending={isSubmitting}
        error={submitError ?? undefined}
        onCancel={() => {
          if (!isSubmitting) {
            setConfirmingKeys(null);
            setSubmitError(null);
          }
        }}
        onConfirm={() => void submitBulkAction()}
      />
    </div>
  );
}

export function WorkspaceDrawer(props: WorkspaceDrawerProps) {
  useViewportScrollLock(props.open);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const onCloseRef = useRef(props.onClose);
  const mode = props.open ? props.mode : null;

  useEffect(() => {
    onCloseRef.current = props.onClose;
  }, [props.onClose]);

  useEffect(() => {
    if (!props.open) {
      return;
    }
    if (mode === "note") {
      noteInputRef.current?.focus();
    } else {
      closeButtonRef.current?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, props.open]);

  if (!props.open) {
    return null;
  }

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={props.onClose}>
      <aside
        className="workspace-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-drawer-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <span>{props.mode === "note" ? "NOTE" : "MY WORDS"}</span>
            <h2 id="workspace-drawer-title">
              {props.mode === "note" ? props.headword : "个人词库"}
            </h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            title="关闭"
            aria-label="关闭"
            onClick={props.onClose}
          >
            <X />
          </button>
        </header>

        {props.mode === "note" ? (
          <div className="note-editor">
            <textarea
              ref={noteInputRef}
              value={props.note}
              aria-label={`${props.headword}的笔记`}
              onChange={(event) => props.onNoteChange(event.target.value)}
            />
            <button type="button" onClick={props.onSaveNote}>
              保存笔记
            </button>
          </div>
        ) : (
          <LibraryPanel key={props.tab} {...props} />
        )}
      </aside>
    </div>
  );
}
