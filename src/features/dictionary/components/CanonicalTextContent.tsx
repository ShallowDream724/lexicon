import { Fragment, type ReactNode } from "react";

import type {
  CanonicalText,
  JsonValue,
  SourceToken,
} from "../../../../packages/dictionary-schema/src/index";

function enabled(value: JsonValue | undefined): boolean {
  return value === true || value === 1 || value === "1";
}

function tokenContent(token: SourceToken, breakBeforeHelp: boolean): ReactNode {
  const tag = token.tag?.toLocaleLowerCase();
  if (tag === "custom-br") {
    return <br />;
  }
  const help = tag === "un" ? /^\[([A-Z][A-Z ]+)\]$/.exec(token.text.trim()) : null;
  if (help) {
    return (
      <>
        {breakBeforeHelp ? <br /> : null}
        <span className="source-token-help">{help[1]}</span>
      </>
    );
  }
  if (!token.text) {
    return null;
  }

  const markerParts = token.text.split(/(\[(?:diomond|diamond)\])/gi);
  let content: ReactNode = markerParts.length > 1
    ? markerParts.map((part, index) =>
        /^\[(?:diomond|diamond)\]$/i.test(part) ? (
          <span className="source-token-diamond" aria-hidden="true" key={index}>◆</span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )
    : token.text;
  if (enabled(token.raw.bold) || tag === "eb" || tag === "cf" || tag === "v") {
    content = <strong>{content}</strong>;
  }
  if (enabled(token.raw.font_Italic) || tag === "geo" || tag === "reg") {
    content = <em>{content}</em>;
  }

  if (tag === "simp") {
    return <span className="source-token-translation">{content}</span>;
  }
  if (tag === "sub") {
    return <sub>{content}</sub>;
  }
  if (tag === "sup") {
    return <sup>{content}</sup>;
  }
  return content;
}

export function CanonicalTextContent({ value }: { value: CanonicalText }) {
  const hasRenderableToken = value.tokens.some(
    (token) => token.text || token.tag?.toLocaleLowerCase() === "custom-br",
  );
  if (!hasRenderableToken) {
    return value.text;
  }

  let hasContentOnLine = false;
  return value.tokens.map((token, index) => {
    const tag = token.tag?.toLocaleLowerCase();
    const help = tag === "un" && /^\[([A-Z][A-Z ]+)\]$/.test(token.text.trim());
    const breakBeforeHelp = help && hasContentOnLine;
    if (tag === "custom-br" || breakBeforeHelp) {
      hasContentOnLine = false;
    } else if (token.text) {
      hasContentOnLine = true;
    }
    return (
      <Fragment key={`${token.tag ?? "text"}-${index}`}>
        {tokenContent(token, breakBeforeHelp)}
      </Fragment>
    );
  });
}
