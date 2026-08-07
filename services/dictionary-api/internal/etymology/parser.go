package etymology

import (
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"unicode"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

const (
	previewLimit          = 512
	previewMarkRecordSize = 5
)

const (
	previewForeignMark byte = 1 << iota
	previewStrongMark
)

// ParseHTML turns the supported source fragment into the public structured form.
func ParseHTML(source string) (Document, error) {
	root := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(source), root)
	if err != nil {
		return Document{}, fmt.Errorf("parse article HTML: %w", err)
	}
	document := Document{}
	implicit := blockBuilder{kind: "paragraph"}
	flushImplicit := func() {
		if block := implicit.block(); block != nil {
			document.Blocks = append(document.Blocks, *block)
		}
		implicit = blockBuilder{kind: "paragraph"}
	}
	for _, node := range nodes {
		switch node.Type {
		case html.TextNode:
			if err := implicit.appendText(node.Data, inlineState{}); err != nil {
				return Document{}, err
			}
		case html.ElementNode:
			switch node.Data {
			case "p":
				flushImplicit()
				block, err := parseBlock(node, "paragraph")
				if err != nil {
					return Document{}, err
				}
				if block != nil {
					document.Blocks = append(document.Blocks, *block)
				}
			case "blockquote":
				flushImplicit()
				block, err := parseBlock(node, "quote")
				if err != nil {
					return Document{}, err
				}
				if block != nil {
					document.Blocks = append(document.Blocks, *block)
				}
			case "span", "a", "strong":
				if err := appendInline(&implicit, node, inlineState{}); err != nil {
					return Document{}, err
				}
			default:
				return Document{}, unsupportedTag(node.Data)
			}
		case html.CommentNode:
			continue
		default:
			return Document{}, fmt.Errorf("unsupported HTML node type %d", node.Type)
		}
	}
	flushImplicit()
	if len(document.Blocks) == 0 {
		return Document{}, fmt.Errorf("article contains no readable content")
	}
	return document, nil
}

func parseBlock(node *html.Node, kind string) (*Block, error) {
	builder := blockBuilder{kind: kind}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if child.Type == html.ElementNode && (child.Data == "p" || child.Data == "blockquote") {
			if builder.hasContent() {
				if err := builder.appendText("\n", inlineState{}); err != nil {
					return nil, err
				}
			}
		}
		if err := appendInline(&builder, child, inlineState{}); err != nil {
			return nil, err
		}
	}
	return builder.block(), nil
}

type inlineState struct {
	foreign bool
	strong  bool
	link    *Link
}

type blockBuilder struct {
	kind string
	runs []TextRun
}

func (b *blockBuilder) appendText(text string, state inlineState) error {
	if text == "" {
		return nil
	}
	marks := make([]string, 0, 2)
	if state.foreign {
		marks = append(marks, "foreign")
	}
	if state.strong {
		marks = append(marks, "strong")
	}
	run := TextRun{Text: text, Marks: marks, Link: state.link}
	if len(b.runs) > 0 && sameFormatting(b.runs[len(b.runs)-1], run) {
		b.runs[len(b.runs)-1].Text += text
		return nil
	}
	b.runs = append(b.runs, run)
	return nil
}

func (b *blockBuilder) hasContent() bool {
	for _, run := range b.runs {
		if strings.TrimSpace(run.Text) != "" {
			return true
		}
	}
	return false
}

func (b *blockBuilder) block() *Block {
	if !b.hasContent() {
		return nil
	}
	return &Block{Kind: b.kind, Runs: b.runs}
}

func appendInline(builder *blockBuilder, node *html.Node, state inlineState) error {
	switch node.Type {
	case html.TextNode:
		return builder.appendText(node.Data, state)
	case html.CommentNode:
		return nil
	case html.ElementNode:
		switch node.Data {
		case "span":
			if hasClass(node, "foreign") {
				state.foreign = true
			}
		case "strong":
			state.strong = true
		case "a":
			link, err := parseLink(attribute(node, "href"))
			if err != nil {
				return err
			}
			state.link = link
		case "p", "blockquote":
			// Nested block elements retain their text in the enclosing block.
		default:
			return unsupportedTag(node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			if err := appendInline(builder, child, state); err != nil {
				return err
			}
		}
		return nil
	default:
		return fmt.Errorf("unsupported HTML node type %d", node.Type)
	}
}

func sameFormatting(left, right TextRun) bool {
	if len(left.Marks) != len(right.Marks) || (left.Link == nil) != (right.Link == nil) {
		return false
	}
	for index := range left.Marks {
		if left.Marks[index] != right.Marks[index] {
			return false
		}
	}
	if left.Link == nil {
		return true
	}
	return *left.Link == *right.Link
}

func attribute(node *html.Node, key string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == key {
			return attribute.Val
		}
	}
	return ""
}

func hasClass(node *html.Node, wanted string) bool {
	for _, class := range strings.Fields(attribute(node, "class")) {
		if class == wanted {
			return true
		}
	}
	return false
}

func parseLink(raw string) (*Link, error) {
	if raw == "" {
		return nil, fmt.Errorf("link has no href")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("unsupported link target %q", raw)
	}
	if strings.EqualFold(parsed.Scheme, "http") || strings.EqualFold(parsed.Scheme, "https") {
		return nil, nil
	}
	if parsed.Path == "/word/" && parsed.RawQuery == "" {
		return nil, nil
	}
	if parsed.IsAbs() || parsed.RawQuery != "" || !strings.HasPrefix(parsed.Path, "/word/") {
		return nil, fmt.Errorf("unsupported link target %q", raw)
	}
	targetTerm, err := url.PathUnescape(strings.TrimPrefix(parsed.EscapedPath(), "/word/"))
	if err != nil {
		return nil, fmt.Errorf("invalid link target %q", raw)
	}
	targetTerm, err = linkTargetText(targetTerm)
	if err != nil || targetTerm == "" || strings.Contains(targetTerm, "/") {
		return nil, fmt.Errorf("invalid link target %q", raw)
	}
	link := &Link{TargetTerm: targetTerm}
	if parsed.Fragment != "" {
		articleID, err := url.PathUnescape(parsed.Fragment)
		if err != nil || strings.TrimSpace(articleID) == "" {
			return nil, fmt.Errorf("invalid link fragment %q", raw)
		}
		link.TargetArticleID = articleID
	}
	return link, nil
}

func linkTargetText(target string) (string, error) {
	target = strings.TrimSpace(target)
	if !strings.ContainsAny(target, "<>") {
		return target, nil
	}
	root := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(target), root)
	if err != nil {
		return "", err
	}
	var text strings.Builder
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.TextNode {
			text.WriteString(node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	for _, node := range nodes {
		visit(node)
	}
	return strings.TrimSpace(text.String()), nil
}

func unsupportedTag(tag string) error { return fmt.Errorf("unsupported structural tag <%s>", tag) }

func Preview(document Document) string {
	return textFromRuns(PreviewRuns(document))
}

func PreviewRuns(document Document) []TextRun {
	runs := make([]TextRun, 0, 8)
	pendingSpace := false
	for blockIndex, block := range document.Blocks {
		if blockIndex > 0 && len(runs) > 0 {
			pendingSpace = true
		}
		for _, source := range block.Runs {
			for _, character := range source.Text {
				if unicode.IsSpace(character) {
					if len(runs) > 0 {
						pendingSpace = true
					}
					continue
				}
				if pendingSpace {
					appendPreviewText(&runs, " ", TextRun{})
					pendingSpace = false
				}
				appendPreviewText(&runs, string(character), source)
			}
		}
	}
	return truncatePreviewRuns(runs)
}

func appendPreviewText(runs *[]TextRun, text string, source TextRun) {
	if text == "" {
		return
	}
	last := len(*runs) - 1
	if last >= 0 && samePreviewStyle((*runs)[last], source) {
		(*runs)[last].Text += text
		return
	}
	marks := append([]string{}, source.Marks...)
	var link *Link
	if source.Link != nil {
		copy := *source.Link
		link = &copy
	}
	*runs = append(*runs, TextRun{Text: text, Marks: marks, Link: link})
}

func samePreviewStyle(left, right TextRun) bool {
	if len(left.Marks) != len(right.Marks) {
		return false
	}
	for index := range left.Marks {
		if left.Marks[index] != right.Marks[index] {
			return false
		}
	}
	if left.Link == nil || right.Link == nil {
		return left.Link == nil && right.Link == nil
	}
	return left.Link.TargetTerm == right.Link.TargetTerm && left.Link.TargetArticleID == right.Link.TargetArticleID
}

func truncatePreviewRuns(runs []TextRun) []TextRun {
	length := 0
	for _, run := range runs {
		length += len([]rune(run.Text))
	}
	if length <= previewLimit {
		return runs
	}
	remaining := previewLimit - 3
	truncated := make([]TextRun, 0, len(runs))
	for _, run := range runs {
		if remaining == 0 {
			break
		}
		characters := []rune(run.Text)
		if len(characters) > remaining {
			characters = characters[:remaining]
		}
		copy := run
		copy.Text = string(characters)
		copy.Marks = append([]string{}, run.Marks...)
		truncated = append(truncated, copy)
		remaining -= len(characters)
	}
	for len(truncated) > 0 {
		last := len(truncated) - 1
		truncated[last].Text = strings.TrimRightFunc(truncated[last].Text, unicode.IsSpace)
		if truncated[last].Text != "" {
			break
		}
		truncated = truncated[:last]
	}
	appendPreviewText(&truncated, "...", TextRun{})
	return truncated
}

func textFromRuns(runs []TextRun) string {
	var builder strings.Builder
	for _, run := range runs {
		builder.WriteString(run.Text)
	}
	return builder.String()
}

func encodePreviewMarks(runs []TextRun) ([]byte, error) {
	encoded := make([]byte, 0, 40)
	offset := 0
	for _, run := range runs {
		length := len([]rune(run.Text))
		flags := byte(0)
		for _, mark := range run.Marks {
			switch mark {
			case "foreign":
				flags |= previewForeignMark
			case "strong":
				flags |= previewStrongMark
			default:
				return nil, fmt.Errorf("unsupported preview mark %q", mark)
			}
		}
		if flags != 0 {
			end := offset + length
			if length == 0 || offset > previewLimit || end > previewLimit {
				return nil, errors.New("preview mark range exceeds the bounded preview")
			}
			record := make([]byte, previewMarkRecordSize)
			binary.LittleEndian.PutUint16(record[0:2], uint16(offset))
			binary.LittleEndian.PutUint16(record[2:4], uint16(end))
			record[4] = flags
			encoded = append(encoded, record...)
		}
		offset += length
	}
	if offset > previewLimit {
		return nil, errors.New("preview exceeds the bounded preview")
	}
	return encoded, nil
}

func decodePreviewMarks(preview string, encoded []byte) ([]TextRun, error) {
	if len(encoded)%previewMarkRecordSize != 0 {
		return nil, errors.New("preview mark projection has an invalid length")
	}
	characters := []rune(preview)
	runs := make([]TextRun, 0, len(encoded)/previewMarkRecordSize*2+1)
	cursor := 0
	for index := 0; index < len(encoded); index += previewMarkRecordSize {
		start := int(binary.LittleEndian.Uint16(encoded[index : index+2]))
		end := int(binary.LittleEndian.Uint16(encoded[index+2 : index+4]))
		flags := encoded[index+4]
		if start < cursor || end <= start || end > len(characters) || flags == 0 || flags&^(previewForeignMark|previewStrongMark) != 0 {
			return nil, errors.New("preview mark projection contains an invalid range")
		}
		if start > cursor {
			appendPreviewText(&runs, string(characters[cursor:start]), TextRun{})
		}
		marks := make([]string, 0, 2)
		if flags&previewForeignMark != 0 {
			marks = append(marks, "foreign")
		}
		if flags&previewStrongMark != 0 {
			marks = append(marks, "strong")
		}
		appendPreviewText(&runs, string(characters[start:end]), TextRun{Marks: marks})
		cursor = end
	}
	if cursor < len(characters) {
		appendPreviewText(&runs, string(characters[cursor:]), TextRun{})
	}
	if len(runs) == 0 && preview != "" {
		appendPreviewText(&runs, preview, TextRun{})
	}
	return runs, nil
}

func validateDocument(document Document) error {
	if len(document.Blocks) == 0 {
		return fmt.Errorf("document has no blocks")
	}
	for _, block := range document.Blocks {
		if (block.Kind != "paragraph" && block.Kind != "quote") || len(block.Runs) == 0 {
			return fmt.Errorf("document has an invalid block")
		}
		for _, run := range block.Runs {
			for _, mark := range run.Marks {
				if mark != "foreign" && mark != "strong" {
					return fmt.Errorf("document has an invalid text mark")
				}
			}
			if run.Link != nil && strings.TrimSpace(run.Link.TargetTerm) == "" {
				return fmt.Errorf("document has an invalid link")
			}
		}
	}
	return nil
}
