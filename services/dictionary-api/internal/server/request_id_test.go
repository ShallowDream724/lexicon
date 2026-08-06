package server_test

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestErrorsCarryTheResponseRequestID(t *testing.T) {
	svc, _ := newFixtureService(t)
	response := get(t, svc, "/api/v1/entries/missing")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d", response.Code)
	}
	requestID := response.Header().Get("X-Request-ID")
	if requestID == "" {
		t.Fatal("response is missing X-Request-ID")
	}
	var payload struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.RequestID != requestID {
		t.Fatalf("body request id = %q, header = %q", payload.RequestID, requestID)
	}
}

func TestUnconfiguredRemoteMediaIsExplicitlyUnavailable(t *testing.T) {
	svc, _ := newFixtureService(t)
	response := get(t, svc, "/api/v1/media/example-audio?key=example")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
}
