package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCreateNote(t *testing.T) {
	s := NewStore()
	req := httptest.NewRequest(http.MethodPost, "/notes", strings.NewReader(`{"author":"a","body":"hi"}`))
	rec := httptest.NewRecorder()
	s.handleCreate(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d", rec.Code)
	}
}
