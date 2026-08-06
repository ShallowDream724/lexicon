package payload

import (
	"fmt"
	"sync"

	"github.com/klauspost/compress/zstd"
)

type Codec interface {
	Name() string
	Compress([]byte) ([]byte, error)
	Decompress([]byte, int64) ([]byte, error)
}

type zstdCodec struct {
	dictionary []byte
	level      int
	once       sync.Once
	encoder    *zstd.Encoder
	decoder    *zstd.Decoder
	err        error
}

func Default() Codec { return &zstdCodec{} }

func NewZstd(dictionary []byte) (Codec, error) {
	return NewZstdWithLevel(dictionary, 3)
}

func NewZstdWithLevel(dictionary []byte, level int) (Codec, error) {
	if level < 1 || level > 22 {
		return nil, fmt.Errorf("zstd compression level %d is outside the supported range 1..22", level)
	}
	codec := &zstdCodec{dictionary: dictionary, level: level}
	codec.once.Do(codec.initialize)
	if codec.err != nil {
		return nil, codec.err
	}
	return codec, nil
}

func (c *zstdCodec) Name() string { return "zstd-dict-json-v1" }

func (c *zstdCodec) initialize() {
	level := c.level
	if level == 0 {
		level = 3
	}
	encoderOptions := []zstd.EOption{zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(level)), zstd.WithEncoderConcurrency(1)}
	if len(c.dictionary) > 0 {
		encoderOptions = append(encoderOptions, zstd.WithEncoderDict(c.dictionary))
	}
	c.encoder, c.err = zstd.NewWriter(nil, encoderOptions...)
	if c.err != nil {
		return
	}
	decoderOptions := []zstd.DOption{zstd.WithDecoderConcurrency(1)}
	if len(c.dictionary) > 0 {
		decoderOptions = append(decoderOptions, zstd.WithDecoderDicts(c.dictionary))
	}
	c.decoder, c.err = zstd.NewReader(nil, decoderOptions...)
}

func (c *zstdCodec) Compress(input []byte) ([]byte, error) {
	c.once.Do(c.initialize)
	if c.err != nil {
		return nil, c.err
	}
	return c.encoder.EncodeAll(input, nil), nil
}

func (c *zstdCodec) Decompress(input []byte, expectedSize int64) ([]byte, error) {
	c.once.Do(c.initialize)
	if c.err != nil {
		return nil, c.err
	}
	decoded, err := c.decoder.DecodeAll(input, nil)
	if err != nil {
		return nil, err
	}
	if int64(len(decoded)) != expectedSize {
		return nil, fmt.Errorf("payload size mismatch: got %d, expected %d", len(decoded), expectedSize)
	}
	return decoded, nil
}

func ByName(name string, dictionary []byte) (Codec, bool, error) {
	if name != "zstd-dict-json-v1" {
		return nil, false, nil
	}
	codec, err := NewZstd(dictionary)
	return codec, true, err
}
