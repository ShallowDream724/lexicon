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

func TestResolverExpandsValidatedMediaURLTemplates(t *testing.T) {
	resolver, err := media.NewResolverWithTemplates(nil, map[media.Kind]string{
		media.Illustration:          "https://media.example.test/full/{prefix1}/{prefix3}/{prefix5}/{key}.png",
		media.IllustrationThumbnail: "https://media.example.test/thumb/{key}.jpg?width=240",
	})
	if err != nil {
		t.Fatal(err)
	}

	imageURL, err := resolver.Resolve(media.Illustration, "rabbit_hare")
	if err != nil {
		t.Fatal(err)
	}
	if imageURL != "https://media.example.test/full/r/rab/rabbi/rabbit_hare.png" {
		t.Fatalf("unexpected illustration URL %q", imageURL)
	}

	thumbnailURL, err := resolver.Resolve(media.IllustrationThumbnail, "tea pot")
	if err != nil {
		t.Fatal(err)
	}
	if thumbnailURL != "https://media.example.test/thumb/tea%20pot.jpg?width=240" {
		t.Fatalf("unexpected thumbnail URL %q", thumbnailURL)
	}
}

func TestResolverRejectsAmbiguousOrUnsafeTemplates(t *testing.T) {
	for name, template := range map[string]string{
		"missing key":         "https://media.example.test/image.png",
		"key in query":        "https://media.example.test/image.png?key={key}",
		"key in host":         "https://{key}.example.test/image/{key}.png",
		"prefix in query":     "https://media.example.test/{key}.png?prefix={prefix1}",
		"unknown placeholder": "https://media.example.test/{bucket}/{key}.png",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := media.NewResolverWithTemplates(nil, map[media.Kind]string{
				media.Illustration: template,
			}); err == nil {
				t.Fatal("unsafe URL template was accepted")
			}
		})
	}

	if _, err := media.NewResolverWithTemplates(
		map[media.Kind]string{media.Illustration: "https://media.example.test/images"},
		map[media.Kind]string{media.Illustration: "https://media.example.test/{key}.png"},
	); err == nil {
		t.Fatal("base URL and URL template were accepted together")
	}

	if _, err := media.NewResolverWithTemplates(nil, map[media.Kind]string{
		media.Kind("unknown"): "https://media.example.test/{key}.png",
	}); err == nil {
		t.Fatal("unsupported media kind was accepted")
	}
}
