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

const (
	defaultMaxConcurrentEmbeddings = 4
	defaultMaxEmbeddingFlights     = 64
)

var errEmbeddingCapacity = errors.New("semantic-search embedding capacity is exhausted")

type Engine struct {
	store                 *Store
	embedder              Embedder
	persistentVectorCache PersistentVectorCache

	mu             sync.Mutex
	pageCapacity   int
	vectorCapacity int
	pages          map[string]*list.Element
	pageLRU        *list.List
	vectors        map[string]*list.Element
	vectorLRU      *list.List
	flights        map[string]*embeddingFlight
	embeddingSlots chan struct{}
	maxFlights     int
	flightContext  context.Context
	cancelFlights  context.CancelFunc
	flightWG       sync.WaitGroup
	closed         bool
	closeOnce      sync.Once
	closeErr       error
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
	return NewEngineWithPersistentVectorCache(store, embedder, pageCapacity, vectorCapacity, nil)
}

func NewEngineWithPersistentVectorCache(store *Store, embedder Embedder, pageCapacity, vectorCapacity int, persistentVectorCache PersistentVectorCache) (*Engine, error) {
	return newEngineWithLimits(
		store, embedder, pageCapacity, vectorCapacity, persistentVectorCache,
		defaultMaxConcurrentEmbeddings, defaultMaxEmbeddingFlights,
	)
}

func newEngineWithLimits(store *Store, embedder Embedder, pageCapacity, vectorCapacity int, persistentVectorCache PersistentVectorCache, maxConcurrentEmbeddings, maxFlights int) (*Engine, error) {
	if store == nil || !store.Available() {
		return nil, errors.New("semantic-search store is unavailable")
	}
	if embedder == nil || embedder.Dimensions() != store.Dimensions() || embedder.ModelKey() != store.ModelKey() {
		return nil, errors.New("semantic-search embedder does not match sidecar metadata")
	}
	if pageCapacity < 0 || vectorCapacity < 0 {
		return nil, errors.New("semantic-search cache capacities must not be negative")
	}
	if maxConcurrentEmbeddings < 1 || maxFlights < maxConcurrentEmbeddings {
		return nil, errors.New("semantic-search embedding limits are invalid")
	}
	flightContext, cancelFlights := context.WithCancel(context.Background())
	return &Engine{
		store: store, embedder: embedder, persistentVectorCache: persistentVectorCache,
		pageCapacity: pageCapacity, vectorCapacity: vectorCapacity,
		pages: make(map[string]*list.Element), pageLRU: list.New(),
		vectors: make(map[string]*list.Element), vectorLRU: list.New(),
		flights:        make(map[string]*embeddingFlight),
		embeddingSlots: make(chan struct{}, maxConcurrentEmbeddings), maxFlights: maxFlights,
		flightContext: flightContext, cancelFlights: cancelFlights,
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
	if e.closed {
		e.mu.Unlock()
		return nil, errors.New("semantic-search engine is closed")
	}
	if element := e.vectors[query]; element != nil {
		e.vectorLRU.MoveToFront(element)
		vector := cloneVector(element.Value.(cachedVector).vector)
		e.mu.Unlock()
		return vector, nil
	}
	flight := e.flights[query]
	if flight == nil {
		if len(e.flights) >= e.maxFlights {
			e.mu.Unlock()
			return nil, errEmbeddingCapacity
		}
		flight = &embeddingFlight{done: make(chan struct{})}
		e.flights[query] = flight
		e.flightWG.Add(1)
		go e.resolveEmbedding(e.flightContext, query, flight)
	}
	e.mu.Unlock()
	select {
	case <-flight.done:
		return cloneVector(flight.vector), flight.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (e *Engine) resolveEmbedding(ctx context.Context, query string, flight *embeddingFlight) {
	defer e.flightWG.Done()
	var vector []float32
	var err error
	if e.persistentVectorCache != nil {
		vector, _ = e.persistentVectorCache.Get(ctx, query)
	}
	if vector == nil {
		select {
		case e.embeddingSlots <- struct{}{}:
			vector, err = e.embedder.Embed(ctx, query, e.store.QueryTemplate(), e.store.QueryExtraJSON())
			<-e.embeddingSlots
			if err == nil && e.persistentVectorCache != nil {
				e.persistentVectorCache.Put(ctx, query, vector)
			}
		case <-ctx.Done():
			err = ctx.Err()
		}
	}

	e.mu.Lock()
	flight.vector, flight.err = cloneVector(vector), err
	if err == nil && !e.closed {
		e.putVectorLocked(query, vector)
	}
	delete(e.flights, query)
	close(flight.done)
	e.mu.Unlock()
}

func (e *Engine) Close() error {
	if e == nil {
		return nil
	}
	e.closeOnce.Do(func() {
		e.mu.Lock()
		e.closed = true
		e.cancelFlights()
		e.mu.Unlock()
		e.flightWG.Wait()
		if cache, ok := e.persistentVectorCache.(interface{ Close() error }); ok {
			e.closeErr = cache.Close()
		}
	})
	return e.closeErr
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
