"use client";

import { Clock3, FileText, Star, X } from "lucide-react";
import { useEffect, useRef } from "react";

import type {
  FavoriteRecord,
  HistoryRecord,
  NoteRecord,
} from "../../../lib/storage/learning-data";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";

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
      onClose: () => void;
    };

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

            <div className="library-list" role="tabpanel">
              {props.tab === "history"
                ? props.history.map((record) => (
                    <button
                      type="button"
                      key={record.key}
                      onClick={() => props.onSelect(record.entryId)}
                    >
                      <strong>{record.headword}</strong>
                      <span>{new Date(record.visitedAt).toLocaleDateString("zh-CN")}</span>
                    </button>
                  ))
                : null}
              {props.tab === "favorites"
                ? props.favorites.map((record) => (
                    <button
                      type="button"
                      key={record.key}
                      onClick={() => props.onSelect(record.entryId)}
                    >
                      <strong>{record.headword}</strong>
                      <span>{new Date(record.createdAt).toLocaleDateString("zh-CN")}</span>
                    </button>
                  ))
                : null}
              {props.tab === "notes"
                ? props.notes.map((record) => (
                    <button
                      type="button"
                      key={record.key}
                      onClick={() => props.onSelect(record.entryId)}
                    >
                      <strong>{record.headword}</strong>
                      <span>{record.text}</span>
                    </button>
                  ))
                : null}

              {(props.tab === "history" && props.history.length === 0) ||
              (props.tab === "favorites" && props.favorites.length === 0) ||
              (props.tab === "notes" && props.notes.length === 0) ? (
                <p className="library-empty">暂无内容</p>
              ) : null}
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
