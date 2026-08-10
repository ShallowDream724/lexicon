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

	mu             sync.Mutex
	pageCapacity   int
	vectorCapacity int
	pages          map[string]*list.Element
	pageLRU        *list.List
	vectors        map[string]*list.Element
	vectorLRU      *list.List
	flights        map[string]*embeddingFlight
}

type cachedPage struct {
	key  string
	page Page
}

type cachedVector struct {
	query  string
	vector []float32
}

type embeddingFlight struct {
	done   chan struct{}
	vector []float32
	err    error
}

func NewEngine(store *Store, embedder Embedder, cacheCapacity int) (*Engine, error) {
	return NewEngineWithCacheCapacities(store, embedder, cacheCapacity, cacheCapacity)
}

func NewEngineWithCacheCapacities(store *Store, embedder Embedder, pageCapacity, vectorCapacity int) (*Engine, error) {
	if store == nil || !store.Available() {
		return nil, errors.New("semantic-search store is unavailable")
	}
	if embedder == nil || embedder.Dimensions() != store.Dimensions() || embedder.ModelKey() != store.ModelKey() {
		return nil, errors.New("semantic-search embedder does not match sidecar metadata")
	}
	if pageCapacity < 0 || vectorCapacity < 0 {
		return nil, errors.New("semantic-search cache capacities must not be negative")
	}
	return &Engine{
		store: store, embedder: embedder,
		pageCapacity: pageCapacity, vectorCapacity: vectorCapacity,
		pages: make(map[string]*list.Element), pageLRU: list.New(),
		vectors: make(map[string]*list.Element), vectorLRU: list.New(),
		flights: make(map[string]*embeddingFlight),
	}, nil
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
	if element := e.vectors[query]; element != nil {
		e.vectorLRU.MoveToFront(element)
		vector := cloneVector(element.Value.(cachedVector).vector)
		e.mu.Unlock()
		return vector, nil
	}
	if flight := e.flights[query]; flight != nil {
		e.mu.Unlock()
		select {
		case <-flight.done:
			return cloneVector(flight.vector), flight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	flight := &embeddingFlight{done: make(chan struct{})}
	e.flights[query] = flight
	e.mu.Unlock()

	vector, err := e.embedder.Embed(ctx, query, e.store.QueryTemplate())

	e.mu.Lock()
	flight.vector, flight.err = cloneVector(vector), err
	if err == nil {
		e.putVectorLocked(query, vector)
	}
	delete(e.flights, query)
	close(flight.done)
	e.mu.Unlock()
	return cloneVector(vector), err
}

func (e *Engine) cachedPage(key string) (Page, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	element := e.pages[key]
	if element == nil {
		return Page{}, false
	}
	e.pageLRU.MoveToFront(element)
	return clonePage(element.Value.(cachedPage).page), true
}

func (e *Engine) putPage(key string, page Page) {
	if e.pageCapacity == 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if element := e.pages[key]; element != nil {
		element.Value = cachedPage{key: key, page: clonePage(page)}
		e.pageLRU.MoveToFront(element)
		return
	}
	e.pages[key] = e.pageLRU.PushFront(cachedPage{key: key, page: clonePage(page)})
	if e.pageLRU.Len() > e.pageCapacity {
		oldest := e.pageLRU.Back()
		delete(e.pages, oldest.Value.(cachedPage).key)
		e.pageLRU.Remove(oldest)
	}
}

func (e *Engine) putVectorLocked(query string, vector []float32) {
	if e.vectorCapacity == 0 {
		return
	}
	if element := e.vectors[query]; element != nil {
		element.Value = cachedVector{query: query, vector: cloneVector(vector)}
		e.vectorLRU.MoveToFront(element)
		return
	}
	e.vectors[query] = e.vectorLRU.PushFront(cachedVector{query: query, vector: cloneVector(vector)})
	if e.vectorLRU.Len() > e.vectorCapacity {
		oldest := e.vectorLRU.Back()
		delete(e.vectors, oldest.Value.(cachedVector).query)
		e.vectorLRU.Remove(oldest)
	}
}

func cloneVector(vector []float32) []float32 { return append([]float32(nil), vector...) }

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
