package semanticsearch

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/text/unicode/norm"
)

type Engine struct {
	store    *Store
	embedder Embedder

	mu       sync.Mutex
	capacity int
	pages    map[string]*list.Element
	lru      *list.List
	flights  map[string]*embeddingFlight
}

type cachedPage struct {
	key  string
	page Page
}
type embeddingFlight struct {
	done   chan struct{}
	vector []float32
	err    error
}

func NewEngine(store *Store, embedder Embedder, cacheCapacity int) (*Engine, error) {
	if store == nil || !store.Available() {
		return nil, errors.New("semantic-search store is unavailable")
	}
	if embedder == nil || embedder.Dimensions() != store.Dimensions() || embedder.ModelKey() != store.ModelKey() {
		return nil, errors.New("semantic-search embedder does not match sidecar metadata")
	}
	if cacheCapacity < 0 {
		return nil, errors.New("semantic-search cache capacity must not be negative")
	}
	return &Engine{store: store, embedder: embedder, capacity: cacheCapacity, pages: make(map[string]*list.Element), lru: list.New(), flights: make(map[string]*embeddingFlight)}, nil
}

func (e *Engine) Search(ctx context.Context, query string, options Options) (Page, error) {
	empty := Page{Groups: []Group{}}
	if e == nil {
		return empty, errors.New("semantic-search engine is unavailable")
	}
	normalized := normalizeQuery(query)
	if normalized == "" {
		return empty, errors.New("semantic-search query must not be empty")
	}
	if _, err := options.Scopes.values(); err != nil {
		return empty, err
	}
	if options.Offset < 0 {
		return empty, errors.New("semantic-search offset must not be negative")
	}
	if options.Limit < 1 {
		return empty, nil
	}
	key := fmt.Sprintf("%s\x00%s\x00%d\x00%d", normalized, options.Scopes.String(), options.Offset, options.Limit)
	if page, ok := e.cachedPage(key); ok {
		return page, nil
	}
	vector, err := e.embedding(ctx, normalized)
	if err != nil {
		return empty, err
	}
	page, err := e.store.Search(ctx, vector, options)
	if err != nil {
		return empty, err
	}
	e.putPage(key, page)
	return clonePage(page), nil
}

func normalizeQuery(query string) string {
	return strings.ToLower(strings.Join(strings.Fields(norm.NFKC.String(query)), " "))
}

func (e *Engine) embedding(ctx context.Context, query string) ([]float32, error) {
	e.mu.Lock()
	if flight := e.flights[query]; flight != nil {
		e.mu.Unlock()
		select {
		case <-flight.done:
			return flight.vector, flight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	flight := &embeddingFlight{done: make(chan struct{})}
	e.flights[query] = flight
	e.mu.Unlock()
	flight.vector, flight.err = e.embedder.Embed(ctx, query)
	e.mu.Lock()
	delete(e.flights, query)
	close(flight.done)
	e.mu.Unlock()
	return flight.vector, flight.err
}

func (e *Engine) cachedPage(key string) (Page, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	element := e.pages[key]
	if element == nil {
		return Page{}, false
	}
	e.lru.MoveToFront(element)
	return clonePage(element.Value.(cachedPage).page), true
}

func (e *Engine) putPage(key string, page Page) {
	if e.capacity == 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if element := e.pages[key]; element != nil {
		element.Value = cachedPage{key: key, page: clonePage(page)}
		e.lru.MoveToFront(element)
		return
	}
	e.pages[key] = e.lru.PushFront(cachedPage{key: key, page: clonePage(page)})
	if e.lru.Len() > e.capacity {
		oldest := e.lru.Back()
		delete(e.pages, oldest.Value.(cachedPage).key)
		e.lru.Remove(oldest)
	}
}

func clonePage(page Page) Page {
	copyPage := page
	copyPage.Groups = make([]Group, len(page.Groups))
	for index, group := range page.Groups {
		copyPage.Groups[index] = group
		copyPage.Groups[index].Matches = append([]Match(nil), group.Matches...)
		for match := range copyPage.Groups[index].Matches {
			copyPage.Groups[index].Matches[match].Location.Path = append([]string(nil), group.Matches[match].Location.Path...)
		}
	}
	return copyPage
}
