package media_test

import (
	"errors"
	"testing"

	"dictionary-api/internal/media"
)

func TestResolverBuildsEscapedStableObjectURLs(t *testing.T) {
	resolver, err := media.NewResolver(map[media.Kind]string{
		media.ExampleAudio: "https://media.example.test/audio/examples",
		media.Illustration: "https://media.example.test/images/",
	})
	if err != nil {
		t.Fatal(err)
	}

	audioURL, err := resolver.Resolve(media.ExampleAudio, "_entry#_gbs_1")
	if err != nil {
		t.Fatal(err)
	}
	if audioURL != "https://media.example.test/audio/examples/_entry%23_gbs_1.wav" {
		t.Fatalf("unexpected audio URL %q", audioURL)
	}

	imageURL, err := resolver.Resolve(media.Illustration, "tea pot")
	if err != nil {
		t.Fatal(err)
	}
	if imageURL != "https://media.example.test/images/tea%20pot.jpg" {
		t.Fatalf("unexpected illustration URL %q", imageURL)
	}
}

func TestResolverRejectsUnsafeKeysAndUnavailableSources(t *testing.T) {
	resolver, err := media.NewResolver(map[media.Kind]string{
		media.ExampleAudio: "https://media.example.test/audio/",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := resolver.Resolve(media.ExampleAudio, "../entry"); !errors.Is(err, media.ErrInvalidKey) {
		t.Fatalf("unsafe key error = %v", err)
	}
	if _, err := resolver.Resolve(media.Illustration, "entry"); !errors.Is(err, media.ErrUnavailable) {
		t.Fatalf("missing source error = %v", err)
	}
	if _, err := media.NewResolver(map[media.Kind]string{
		media.ExampleAudio: "file:///tmp/audio/",
	}); err == nil {
		t.Fatal("file media base URL was accepted")
	}
}
